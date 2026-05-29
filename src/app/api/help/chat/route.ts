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
 * 課金 (ADR-0027):
 *   - featureUnit: 'help-chat' (LEARNING_FREE_FEATURE_UNITS)
 *   - cost = 0 (全プラン無料、学習コストとして運営吸収)
 *   - withMeteredLLM 経由ではなく本 route 内で直接 ApiCallLog INSERT + Counter increment
 *   - テナント単位月 100 回上限 (HELP_CHAT_MONTHLY_LIMIT_PER_TENANT)
 *
 * 上限到達時:
 *   - HTTP 429 + { fallbackToAccordion: true } を返却
 *   - UI 側 (HelpChatInput) が入力欄を disable してアコーディオン誘導
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
 *   - 設計: docs/adr/0027-help-ai-concierge.md (PR7 で作成予定)
 *   - 仕様: docs/specification/HELP_CHAT.md (PR7 で作成予定)
 *   - 開発者ガイド: docs/developer-guide/FAQ_AND_OWL_CHAT_GUIDE.md
 *   - データ: src/config/faq-content.ts / src/config/guide-content.ts
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { applyRateLimit } from '@/lib/rate-limit';
import { prisma } from '@/lib/db';
import { getAnthropicClient } from '@/lib/llm/anthropic-client';
import { recordError } from '@/services/error-log.service';
import {
  buildFaqPromptSection,
  getFaqEntriesForRole,
  type ViewerRoles,
} from '@/config/faq-content';
import {
  buildGuidePromptSection,
  getGuideStepsForRole,
} from '@/config/guide-content';
import { buildRoleGuardancePromptSection } from '@/config/faq-content';
import { HELP_CHAT_MONTHLY_LIMIT_PER_TENANT } from '@/config/billing-feature-units';

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

function buildSystemPrompt(viewer: ViewerRoles): string {
  const sections = [
    PERSONA_PROMPT_HEAD,
    '',
    '【開示制限 (★重要 — 必ず守ること★)】',
    buildRoleGuardancePromptSection(viewer),
    '',
    '【許可された FAQ】',
    buildFaqPromptSection(viewer),
    '',
    '【許可された使い方ガイド】',
    buildGuidePromptSection(viewer),
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

  // 5. system prompt 構築
  const systemPrompt = buildSystemPrompt(viewer);
  const outputInstruction = buildOutputSchemaInstruction();

  // 6. Anthropic Claude Haiku 呼び出し
  const requestId = crypto.randomUUID();
  let output: HelpChatOutput;
  let llmInputTokens = 0;
  let llmOutputTokens = 0;
  try {
    const client = getAnthropicClient();
    const message = await client.messages.create({
      model: MODEL_NAME,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: `${input.query}\n\n---\n${outputInstruction}`,
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

  // 7. ★severity-1★ defense-in-depth: sourceFaqIds / sourceGuideStepIds の権限再検証
  //    AI が許可外の id を hallucination で返した場合に備え、必ずフィルタする
  const allowedFaqIds = new Set(getFaqEntriesForRole(viewer).map((e) => e.id));
  const allowedGuideStepIds = new Set(getGuideStepsForRole(viewer).map((s) => s.id));
  const sourceFaqIds = output.sourceFaqIds.filter((id) => allowedFaqIds.has(id));
  const sourceGuideStepIds = output.sourceGuideStepIds.filter((id) =>
    allowedGuideStepIds.has(id),
  );

  // 8. Counter + ApiCallLog の atomic update
  const latencyMs = Math.round(performance.now() - startTime);
  try {
    await prisma.$transaction([
      prisma.tenant.update({
        where: { id: user.tenantId },
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

  // 9. response
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
