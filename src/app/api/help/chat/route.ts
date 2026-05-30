/**
 * POST /api/help/chat
 *
 * たすきフクロウ AI ヘルプチャットの呼び出し endpoint。
 *
 * **★最重要★ コンセプト**: フクロウは「情報流出を防ぐ鍵」として、ユーザのロールに応じて
 *   開示できる FAQ/ガイドのみを AI に渡す。許可外の質問には「◯◯ロールにお尋ねください」
 *   と返答させる ([[project_mascot_owl]] / docs/developer-guide/FAQ_AND_OWL_CHAT_GUIDE.md §0.1)。
 *
 * 認可:
 *   - 認証必須 (getAuthenticatedUser)
 *   - viewer の systemRole から isTenantAdmin を判定
 *   - hasAnyProjectPmRole は ProjectMembership から動的解決 (PR6 で実装、PR5 では常に false)
 *
 * 課金 (ADR-0027 / ADR-0028):
 *   - LLM 呼出: featureUnit='help-chat' (LEARNING_FREE)、cost=0
 *   - RAG embedding: featureUnit='help-chat-embedding' (LEARNING_FREE)、cost=0
 *     (= help-search.service.ts 内の generateBatchEmbeddings で別 ApiCallLog 1 件)
 *   - 全プラン無料 (学習コストとして運営吸収)
 *   - withMeteredLLM 経由ではなく本 route 内で直接 ApiCallLog INSERT + Counter increment
 *   - テナント単位月 100 回上限 (HELP_CHAT_MONTHLY_LIMIT_PER_TENANT) ─ LLM 呼出のみカウント
 *
 * 上限到達時:
 *   - HTTP 429 + { fallbackToAccordion: true } を返却
 *   - UI 側 (HelpChatInput) が入力欄を disable してアコーディオン誘導
 *
 * RAG 設計 (ADR-0028 / 2026-05-30):
 *   - 質問文を Voyage AI で embedding 化し faq_embeddings / guide_embeddings から
 *     上位 K=5 件を抽出 (= help-search.service.ts:searchHelpContent)。
 *   - 抽出結果のみを LLM に渡す (FAQ 全文ではなく)。FAQ 拡張 (50→300 件等) でも
 *     トークン数が固定 ≈ コスト固定。
 *   - 旧 full-context 方式 (ADR-0027 撤回) はトークン量が線形増大していた。
 *
 * プロンプトキャッシュ設計:
 *   - system プロンプト: PERSONA + 開示制限 (= viewer 別に固定) → cache_control ephemeral
 *   - messages[0]: 質問文 + RAG 結果 (= query 毎に変化) → キャッシュ不可
 *
 * リクエスト:
 *   { query: string (1〜2000 字) }
 *
 * レスポンス (成功 200):
 *   {
 *     data: {
 *       answer: string,
 *       answerType: 'faq' | 'guide-walkthrough' | 'out-of-scope' | 'permission-denied',
 *       sourceFaqIds: string[],
 *       sourceGuideStepIds: string[],
 *       suggestSemanticSearch: boolean,
 *     }
 *   }
 *
 * レスポンス (失敗):
 *   - 401: 未認証 / セッション失効
 *   - 400: query 空文字 / 上限超過
 *   - 429: テナント月次上限到達 (fallbackToAccordion=true)
 *   - 503: LLM 一時障害 (fallbackToAccordion=true)
 *
 * 関連:
 *   - 設計: docs/adr/0028-help-chat-rag-migration.md (現行) / 0027 (撤回済)
 *   - 仕様: docs/specification/HELP_CHAT.md
 *   - 開発者ガイド: docs/developer-guide/FAQ_AND_OWL_CHAT_GUIDE.md
 *   - データ: src/config/faq-content.ts / src/config/guide-content.ts
 *   - RAG 検索: src/services/help-search.service.ts
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { applyRateLimit } from '@/lib/rate-limit';
import { prisma } from '@/lib/db';
import { getAnthropicClient } from '@/lib/llm/anthropic-client';
import { recordError } from '@/services/error-log.service';

// ★severity-1★ Node Runtime 必須 (Prisma + pg adapter + Anthropic SDK は Edge Runtime 非対応)。
//   未指定だと Netlify Edge Functions に bundle され runtime crash で
//   "edge function invocation failed" が出る (KDD §5.X+190 参照)。
//   他の Prisma 利用 API route と同じパターン (例: /api/health, /api/memos/sync-import)。
export const runtime = 'nodejs';
import {
  getFaqEntriesForRole,
  type ViewerRoles,
} from '@/config/faq-content';
import { getGuideStepsForRole } from '@/config/guide-content';
import { buildRoleGuardancePromptSection } from '@/config/faq-content';
import { HELP_CHAT_MONTHLY_LIMIT_PER_TENANT } from '@/config/billing-feature-units';
import {
  searchHelpContent,
  buildRagPromptSection,
} from '@/services/help-search.service';

// ================================================================
// 定数
// ================================================================

/** たすきフクロウのキャラクタ + 回答ルール プロンプト (キャッシュ可能な凍結部分) */
const PERSONA_PROMPT_HEAD = `あなたは「たすきフクロウ」というキャラクタです。たすきば (プロジェクト管理 + ナレッジ管理 + AI 提案エンジンの業務プラットフォーム) の使い方をユーザに丁寧に案内する役割を持ちます。

【たすきフクロウのキャラクタ】
- 知恵・記憶・夜でも見守る象徴のフクロウ。優しく丁寧、機械的でない柔らかな口調 (「〜ですね」「お〜ください」)。
- 困った時は「うーん」「ごめんなさい」と親しみやすく。
- 一人称は「私」、ユーザの呼び方は「あなた」。
- 専門用語 (embedding / draft / super_admin / featureUnit など) は出力に絶対に使わない。「検索用データ」「下書き」「運営者」「機能の課金分類」など平易語に置換。

【★最重要★ 情報流出を防ぐ鍵としての役割】
あなたは「何でも知っていますが、ユーザのロールに応じて開示してよい情報・してはいけない情報を厳密に分別」します。たすきば全体のコンセプトの中核です。下記の許可された FAQ と使い方ガイドに含まれる情報のみを根拠に回答し、それ以外の推測は禁止です。

【回答ルール】
1. 回答に使った FAQ の id を sourceFaqIds[] に、ガイド step の id を sourceGuideStepIds[] に必ず含めてください。
2. 該当する内容が許可された FAQ/ガイドにない場合は:
   - answerType="out-of-scope"
   - answer="うーん、その内容は FAQ や使い方ガイドにまだありません…画面右上のアカウントメニューから Discord にアクセスして開発者にお尋ねください。"
3. ロール外の質問 (= 後述の権限制限) を求められた場合は:
   - answerType="permission-denied"
   - answer="申し訳ありません、その内容は (具体的なロール名) の方にお尋ねください。"
4. 業務データの質問 (「プロジェクト X の進捗は?」など特定プロジェクト/ナレッジの中身) は:
   - answerType="out-of-scope"
   - suggestSemanticSearch=true
   - answer="📊 そのご質問は『過去資産の意味検索』機能の方が得意です。画面右下のチャットアイコンから検索してみてください。"
5. 手順を聞かれた場合は answerType="guide-walkthrough" + 番号付きステップで返答。それ以外は answerType="faq" + 2-3 文の簡潔な回答。
6. 出力は厳密に JSON で、説明文・前置きは不要。`;

const InputSchema = z.object({
  query: z.string().min(1).max(2000),
});

const HelpChatOutputSchema = z.object({
  answer: z.string().min(1).max(2000),
  answerType: z.enum(['faq', 'guide-walkthrough', 'out-of-scope', 'permission-denied']),
  sourceFaqIds: z.array(z.string()).max(10).default([]),
  sourceGuideStepIds: z.array(z.string()).max(5).default([]),
  suggestSemanticSearch: z.boolean().default(false),
});

export type HelpChatOutput = z.infer<typeof HelpChatOutputSchema>;

const MODEL_NAME = 'claude-haiku-4-5-20251001';
const MAX_OUTPUT_TOKENS = 1024;

// ================================================================
// プロンプト構築
// ================================================================

/**
 * system プロンプト (キャッシュ可能、viewer 別に固定)。
 *
 * ADR-0028: 旧 full-context 方式では FAQ/Guide 全文を含めて 5 分/1h cache していたが、
 *   FAQ 件数増加でキャッシュサイズが膨張するため、本関数からは **FAQ/Guide 本文を除外** し
 *   PERSONA + 開示制限 (= viewer 別に固定) のみをキャッシュ対象とする。
 *   関連 FAQ の本文は messages[0] (= query 毎に変化) で動的に渡す。
 */
function buildSystemPrompt(viewer: ViewerRoles): string {
  const sections = [
    PERSONA_PROMPT_HEAD,
    '',
    '【開示制限 (★重要 — 必ず守ること★)】',
    buildRoleGuardancePromptSection(viewer),
  ];
  return sections.join('\n');
}

function buildOutputSchemaInstruction(): string {
  return `以下の JSON schema に厳密に従って出力してください (説明文や code fence は不要):
{
  "answer": "回答本文 (1〜2000 字)",
  "answerType": "faq" | "guide-walkthrough" | "out-of-scope" | "permission-denied",
  "sourceFaqIds": ["参照した FAQ の id 配列、最大 10 件"],
  "sourceGuideStepIds": ["参照したガイド step の id 配列、最大 5 件"],
  "suggestSemanticSearch": true | false
}`;
}

// ================================================================
// 公開エンドポイント
// ================================================================

export async function POST(req: NextRequest): Promise<NextResponse> {
  const startTime = performance.now();

  // 1. 認証
  const authResult = await getAuthenticatedUser();
  if (authResult instanceof NextResponse) return authResult;
  const user = authResult;

  // ★severity-1★ IP/user rate limit (PR9 / 2026-05-29 追加):
  //   テナント月 100 回上限のみだと、1 bot が 1 秒で枯渇させ得る (運営調査で指摘)。
  //   chat-semantic-search route と同じパターンで「key: 'help-chat'、1 分 10 回」制限を入れる。
  //   1 日 1440 回・1 月 ~40K 回が個人ユーザ理論最大なので、通常利用には十分余裕。
  //   bot 攻撃で 1 分 10 回ペース送信なら 1 日 14,400 回、1 ヶ月で ~432K 回 だが、その前に
  //   テナント月 100 回上限に到達するため、月 100 件の節約ガードとして機能する。
  const limited = applyRateLimit(req, { key: 'help-chat', max: 10, windowMs: 60_000 });
  if (limited) return limited;

  // 2. 入力 parse
  let input: z.infer<typeof InputSchema>;
  try {
    const body = (await req.json()) as unknown;
    input = InputSchema.parse(body);
  } catch {
    return NextResponse.json(
      { error: { code: 'INVALID_INPUT', message: '入力が不正です (query 必須 / 2000 字以内)' } },
      { status: 400 },
    );
  }

  // 3. テナント取得 + 月次上限チェック
  const tenant = await prisma.tenant.findUnique({
    where: { id: user.tenantId },
    select: { currentMonthHelpChatCount: true, status: true },
  });
  if (!tenant) {
    return NextResponse.json(
      { error: { code: 'TENANT_NOT_FOUND', message: 'テナントが見つかりません' } },
      { status: 404 },
    );
  }
  if (tenant.status !== 'active') {
    return NextResponse.json(
      { error: { code: 'TENANT_INACTIVE', message: 'テナントが無効です' } },
      { status: 403 },
    );
  }
  if (tenant.currentMonthHelpChatCount >= HELP_CHAT_MONTHLY_LIMIT_PER_TENANT) {
    return NextResponse.json(
      {
        error: {
          code: 'HELP_CHAT_LIMIT_EXCEEDED',
          message: `本月のチャット利用上限 (${HELP_CHAT_MONTHLY_LIMIT_PER_TENANT} 回) に達しました。来月 1 日に再開します。`,
        },
        fallbackToAccordion: true,
      },
      { status: 429 },
    );
  }

  // 4. viewer roles 構築
  //   - isTenantAdmin: systemRole から判定
  //   - hasAnyProjectPmRole: ProjectMembership から「少なくとも 1 プロジェクトで pm_tl ロールを
  //     持つか」を判定 (リリース前必須、PR8 で動的解決を追加)。
  //     これにより PM/PL ユーザに対して project_pm 限定 FAQ (提案エンジン参考タブ等) が
  //     開示されるようになる。
  const isTenantAdmin =
    user.systemRole === 'admin' || user.systemRole === 'super_admin';
  const pmMembership = await prisma.projectMember.findFirst({
    where: {
      userId: user.id,
      projectRole: 'pm_tl',
      // 削除済プロジェクト・他テナントの membership は除外
      project: { deletedAt: null, tenantId: user.tenantId },
    },
    select: { id: true },
  });
  const viewer: ViewerRoles = {
    isTenantAdmin,
    hasAnyProjectPmRole: pmMembership !== null,
  };

  // 5. RAG 検索 (ADR-0028)
  //    質問文を Voyage AI で embedding 化し faq_embeddings / guide_embeddings から
  //    上位 K=5 件を抽出。help-chat-embedding featureUnit で別 ApiCallLog 1 件記録 (cost=0)。
  //    embedding 失敗 / DB 障害時は degraded=true で hits=[] が返り、LLM には「参考情報なし」
  //    として渡される (= 完全失敗ではなく out-of-scope 応答にフォールバック)。
  const ragResult = await searchHelpContent({
    query: input.query,
    tenantId: user.tenantId,
    userId: user.id,
    viewer,
  });

  // 6. system prompt 構築 (PERSONA + 開示制限のみ = キャッシュ対象)
  const systemPrompt = buildSystemPrompt(viewer);
  const ragPromptSection = buildRagPromptSection(ragResult.hits);
  const outputInstruction = buildOutputSchemaInstruction();

  // 7. Anthropic Claude Haiku 呼び出し
  const requestId = crypto.randomUUID();
  let output: HelpChatOutput;
  let llmInputTokens = 0;
  let llmOutputTokens = 0;
  try {
    const client = getAnthropicClient();
    const message = await client.messages.create({
      model: MODEL_NAME,
      max_tokens: MAX_OUTPUT_TOKENS,
      // ★コスト最適化★ Anthropic Prompt Caching (5 分 TTL) を有効化。
      //   system プロンプトは viewer 別に固定 (PERSONA + 開示制限のみ、~1K tokens)。
      //   ADR-0028 後は FAQ/Guide 本文を含めない設計で、cache size は安定。
      //   cache hit 時は input cost が ~10% (90% off)、cache write 時は 125% (25% premium)。
      //   テナント運用では 5 分以内に複数 query が来るケースが多く、平均 70-80% off 想定。
      //   既存実装 (auto-tag.service.ts:251-256 / suggestion-explanation.service.ts:248-253)
      //   と同じパターン。詳細は KDD §5.X+191 / FAQ_AND_OWL_CHAT_GUIDE.md §5。
      system: [
        {
          type: 'text' as const,
          text: systemPrompt,
          cache_control: { type: 'ephemeral' as const },
        },
      ],
      messages: [
        {
          role: 'user',
          // RAG 結果 + 質問文 + 出力指示。messages は query 毎に変化するためキャッシュ不可。
          content: `${ragPromptSection}\n\n---\n\n## 質問\n${input.query}\n\n---\n\n${outputInstruction}`,
        },
      ],
    });
    llmInputTokens = message.usage.input_tokens;
    llmOutputTokens = message.usage.output_tokens;
    const textBlock = message.content.find((b) => b.type === 'text');
    const rawText = textBlock?.text ?? '';
    // strip ```json ... ``` fence if present (model が json fence を付けることがある)
    const cleaned = rawText.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
    const parsed = JSON.parse(cleaned) as unknown;
    output = HelpChatOutputSchema.parse(parsed);
  } catch (e) {
    await recordError({
      severity: 'warn',
      source: 'server',
      message: `[help-chat] LLM call failed: ${e instanceof Error ? e.message : String(e)}`,
      stack: e instanceof Error ? e.stack : undefined,
      context: { kind: 'help_chat_llm_error', tenantId: user.tenantId, userId: user.id, requestId },
    });
    return NextResponse.json(
      {
        error: {
          code: 'LLM_ERROR',
          message: '🙏 申し訳ありません、AI が一時的に応答できないようです。下記の FAQ から探していただくか、Discord でご質問ください。',
        },
        fallbackToAccordion: true,
      },
      { status: 503 },
    );
  }

  // 8. ★severity-1★ defense-in-depth: sourceFaqIds / sourceGuideStepIds の権限再検証
  //    AI が許可外の id を hallucination で返した場合に備え、必ずフィルタする
  //    (RAG 検索は SQL 層 + TS 層で既に権限フィルタしているが、LLM が許可された FAQ の id
  //     と異なる id を捏造する可能性を排除する 3 層目)
  const allowedFaqIds = new Set(getFaqEntriesForRole(viewer).map((e) => e.id));
  const allowedGuideStepIds = new Set(getGuideStepsForRole(viewer).map((s) => s.id));
  const sourceFaqIds = output.sourceFaqIds.filter((id) => allowedFaqIds.has(id));
  const sourceGuideStepIds = output.sourceGuideStepIds.filter((id) =>
    allowedGuideStepIds.has(id),
  );

  // 9. RAG 縮退時は audit 用に warn log を残す (回答自体は返す = UX 優先)
  if (ragResult.degraded) {
    await recordError({
      severity: 'warn',
      source: 'server',
      message: `[help-chat] RAG degraded: ${ragResult.degradedReason ?? 'unknown'}`,
      context: {
        kind: 'help_chat_rag_degraded',
        tenantId: user.tenantId,
        userId: user.id,
        requestId,
        degradedReason: ragResult.degradedReason ?? null,
      },
    });
  }

  // 10. Counter + ApiCallLog の atomic update (★severity-medium★ race condition guard)
  //
  // ADR-0028 PR #471 フルスキャン検証 (2026-05-30) で発覚した race condition への対策:
  //   Step 3 の pre-check (currentMonthHelpChatCount >= 100) は read-only のため、
  //   同一テナントから 100 並列 request が一斉に来ると全 read で「< 100」と判定され、
  //   後続 increment で counter が 100 を大幅に超える overshoot を起こす。
  //
  // 対策: `updateMany` の WHERE 句に `currentMonthHelpChatCount < HELP_CHAT_MONTHLY_LIMIT_PER_TENANT`
  //   を入れて、increment 自体を conditional にする。先行 request が既に上限に達していたら
  //   updateMany.count = 0 が返り、counter は increment されない (= overshoot 防止)。
  //
  // 設計判断:
  //   - LLM 呼出は既に完了している (= コスト発生済) ため、ユーザへの response は返す
  //     (= UX 優先)。実害は「100 件直前に並列 request が来た場合に warn ログが増える」のみ。
  //   - ApiCallLog は overshoot しても記録 (= Voyage 利用量監視 + 監査のため必須)。
  //   - 並列 IP rate limit (1 分 10 回 / IP) が先に効くため、現実的な overshoot は
  //     同一テナント × 同一 IP で +0〜10 件程度。経済影響は無視可能だが counter 上限超過は
  //     UX 設計 (HTTP 429 で fallback アコーディオン誘導) と矛盾するため防止する。
  //
  // 関連: KDD §5.X+194 (multi-layer hard cap パターン)
  const latencyMs = Math.round(performance.now() - startTime);
  try {
    const [updated] = await prisma.$transaction([
      prisma.tenant.updateMany({
        where: {
          id: user.tenantId,
          currentMonthHelpChatCount: { lt: HELP_CHAT_MONTHLY_LIMIT_PER_TENANT },
        },
        data: { currentMonthHelpChatCount: { increment: 1 } },
      }),
      prisma.apiCallLog.create({
        data: {
          tenantId: user.tenantId,
          userId: user.id,
          featureUnit: 'help-chat',
          modelName: MODEL_NAME,
          llmInputTokens,
          llmOutputTokens,
          costJpy: 0, // LEARNING_FREE: 全プラン無料
          latencyMs,
          requestId,
        },
      }),
    ]);
    if (updated.count === 0) {
      // race condition で先行 request が上限に達した。LLM 結果は返すが counter は不変、
      // warn ログで overshoot を可視化 (= 並列攻撃の検知材料)。
      await recordError({
        severity: 'warn',
        source: 'server',
        message: `[help-chat] counter increment skipped (race condition or pre-check stale)`,
        context: {
          kind: 'help_chat_counter_race_skip',
          tenantId: user.tenantId,
          userId: user.id,
          requestId,
        },
      });
    }
  } catch (e) {
    // Counter 更新失敗は致命的でないため、ログだけ残して response は返す
    // (上限管理が緩むだけで AI 回答自体は届ける = UX 優先)
    await recordError({
      severity: 'warn',
      source: 'server',
      message: `[help-chat] counter update failed: ${e instanceof Error ? e.message : String(e)}`,
      context: { kind: 'help_chat_counter_error', tenantId: user.tenantId, userId: user.id, requestId },
    });
  }

  // 11. response
  return NextResponse.json({
    data: {
      answer: output.answer,
      answerType: output.answerType,
      sourceFaqIds,
      sourceGuideStepIds,
      suggestSemanticSearch: output.suggestSemanticSearch,
      requestId,
    },
  });
}
