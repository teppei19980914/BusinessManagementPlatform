/**
 * たすきフクロウ AI ヘルプチャット RAG 検索サービス (ADR-0028)
 *
 * 目的:
 *   ユーザの質問文を Voyage AI で embedding 化し、`faq_embeddings` /
 *   `guide_embeddings` テーブルから pgvector Cosine 類似度で上位 K 件を抽出する。
 *   結果は `/api/help/chat` route が LLM プロンプトに注入する。
 *
 * 既存設計の流用 ([[feedback_reuse_existing_design_first]]):
 *   - クエリ embedding 生成: `src/services/embedding.service.ts` の
 *     `generateBatchEmbeddings({ texts: [query], inputType: 'query' })` を使用
 *     (= 1 ApiCallLog に集約、`featureUnit='help-chat-embedding'`)。
 *   - pgvector 検索パターン: `src/services/chat-search.service.ts` の `pgvectorSearch`
 *     と完全に同じ `1 - (("content_embedding" <=> ${q}::vector) / 2) AS score` 形式。
 *   - SQL injection 対策: テーブル名は TypeScript union で静的固定、値はすべて
 *     tagged template の自動 parametrized binding。
 *
 * 権限 defense-in-depth (★severity-1★ ADR-0028 §6):
 *   1. **SQL 層**: WHERE `requires_admin = false OR ${viewer.isTenantAdmin}::boolean`
 *      で top-K を絞り込む。
 *   2. **TS 層**: 取得結果を `getFaqEntriesForRole(viewer)` の id 集合と intersect
 *      し、SQL 漏れを再検証 (= 万一 denormalize された権限 flag が drift しても
 *      安全側に倒れる)。
 *   3. **LLM 層**: `buildRoleGuardancePromptSection(viewer)` を system prompt に
 *      含め、ロール外の質問には開示せず案内文を返すよう LLM に指示。
 *
 * source-of-truth:
 *   - 本文・権限定義: `src/config/faq-content.ts` / `guide-content.ts`
 *   - embedding ベクトル: DB (`faq_embeddings.content_embedding`)
 *   - drift 検知: `scripts/check-faq-embeddings-sync.ts` が両者を SHA-256 で突合
 *
 * 関連:
 *   - docs/adr/0028-help-chat-rag-migration.md
 *   - src/app/api/help/chat/route.ts (本サービスの唯一の呼出元)
 *   - scripts/generate-faq-embeddings.ts (本サービスと **同じ** composeFaqContentText
 *     / computeContentHash を使うこと。drift 検知の前提)
 */

import { createHash } from 'node:crypto';

import { prisma } from '@/lib/db';
import {
  generateBatchEmbeddings,
  type GenerateBatchEmbeddingsResult,
} from '@/services/embedding.service';
import {
  type FaqEntry,
  type FaqVisibleTo,
  type ViewerRoles,
  getFaqEntriesForRole,
  getFaqEntryById,
} from '@/config/faq-content';
import {
  type GuideStep,
  getGuideStepsForRole,
  getGuideStepById,
} from '@/config/guide-content';

/**
 * RAG 検索結果の 1 件 (FAQ / Guide 共通)。
 *
 * - `snapshot`: LLM プロンプトに注入する本文 (= DB の content_snapshot)。
 *   source-of-truth は config 側だが、deploy 直後の乖離瞬間でも回答品質を維持。
 * - `score`: pgvector Cosine similarity (0.0-1.0、1 が完全一致)。
 */
export interface HelpSearchHit {
  kind: 'faq' | 'guide';
  /** FAQ.id または GuideStep.id (= 出典として LLM 応答の sourceFaqIds / sourceGuideStepIds に入る) */
  entryId: string;
  snapshot: string;
  score: number;
}

/**
 * `searchHelpContent` の戻り値。
 *
 * - `costJpy`: 常に 0 (`help-chat-embedding` は LEARNING_FREE_FEATURE_UNITS)
 * - `requestId`: ApiCallLog の id。help-chat route 側の audit log と紐付け用
 * - `degraded`: embedding 生成失敗時の縮退モード。route 側で fallback 文言を返すか
 *   判断する。`hits=[]` でも `degraded=false` (= 関連 FAQ が無いだけ) なら通常応答可
 */
export interface SearchHelpContentResult {
  hits: HelpSearchHit[];
  costJpy: number;
  requestId: string | null;
  /** true = embedding 生成失敗 (= 縮退モード、route 側で fallback すべき) */
  degraded: boolean;
  /** 縮退理由 (`degraded=true` の場合のみ意味あり) */
  degradedReason?: string;
}

/**
 * RAG 検索の上位件数。FAQ + Guide 合算でこの件数を返す (各テーブル別に top-K を取って merge)。
 *
 * - 大きすぎる: LLM プロンプトが肥大化しキャッシュ効果が落ちる
 * - 小さすぎる: ユーザの質問に該当する FAQ が拾えず精度低下
 *
 * 5 件 ≒ プロンプト ~3000 tokens 程度 (FAQ 最長 1412 文字想定)。
 */
export const HELP_SEARCH_DEFAULT_LIMIT = 5;

// ================================================================
// 公開関数 (★ scripts/generate-faq-embeddings.ts と共有 ★)
// ================================================================

/**
 * FAQ 1 件の embedding/hashing 対象テキストを生成する。
 *
 * **drift 検知の前提**: 本関数の出力が変わると content_hash も変わるため、
 * scripts/generate-faq-embeddings.ts と scripts/check-faq-embeddings-sync.ts は
 * 必ず本関数を使うこと。重複定義による hash drift = 全件再生成の罠を防ぐ。
 *
 * 形式: 「Q: ... \n\nA: ...」(category は別カラムで保持するため text に含めない)
 */
export function composeFaqContentText(entry: FaqEntry): string {
  return `Q: ${entry.q}\n\nA: ${entry.a}`;
}

/**
 * GuideStep 1 件の embedding/hashing 対象テキストを生成する。
 *
 * 形式: 「タイトル: ... \n\n手順: ...」
 */
export function composeGuideContentText(step: GuideStep): string {
  return `タイトル: ${step.title}\n\n手順: ${step.body}`;
}

/**
 * SHA-256 hex digest。drift 検知の content_hash 計算に使う。
 *
 * 入力テキストは composeFaqContentText / composeGuideContentText の戻り値を渡す。
 */
export function computeContentHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * `visibleTo` を denormalize した 3 つの boolean フラグに変換する。
 *
 * - `all`: 全 false (= 誰でも見れる)
 * - `project_member`: requiresProjectMember=true
 * - `project_pm`: requiresProjectPm=true
 * - `tenant_admin`: requiresAdmin=true
 *
 * SQL 側で `WHERE requires_xxx = false OR ${canXxx}` の形でフィルタするための前処理
 * (各エントリは高々 1 フラグのみ true)。
 */
export function mapVisibleToFlags(visibleTo: FaqVisibleTo): {
  requiresAdmin: boolean;
  requiresProjectPm: boolean;
  requiresProjectMember: boolean;
} {
  return {
    requiresAdmin: visibleTo === 'tenant_admin',
    requiresProjectPm: visibleTo === 'project_pm',
    requiresProjectMember: visibleTo === 'project_member',
  };
}

/**
 * viewer の権限を「各開示段を見られるか」の階層内包 boolean に変換する。
 * SQL の権限フィルタ (Layer 1) に渡す。canViewerSee (TS Layer 2) と同じ内包関係:
 *   - canAdmin  = isTenantAdmin
 *   - canPm     = hasAnyProjectPmRole OR isTenantAdmin
 *   - canMember = hasAnyProjectMembership OR hasAnyProjectPmRole OR isTenantAdmin
 */
function viewerTierFlags(viewer: ViewerRoles): {
  canAdmin: boolean;
  canPm: boolean;
  canMember: boolean;
} {
  const canAdmin = viewer.isTenantAdmin;
  const canPm = viewer.hasAnyProjectPmRole || canAdmin;
  const canMember = viewer.hasAnyProjectMembership || canPm;
  return { canAdmin, canPm, canMember };
}

// ================================================================
// 内部: pgvector RAG 検索
// ================================================================

interface RawHit {
  entry_id: string;
  score: number;
}

/**
 * `faq_embeddings` から上位 K 件を取得する。
 *
 * 権限フィルタ (defense-in-depth Layer 1):
 *   - `requires_admin = false OR ${viewer.isTenantAdmin}` で SQL 段で絞る。
 *   - 結果は上位呼び出し元で getFaqEntriesForRole と intersect して再検証 (Layer 2)。
 */
async function pgvectorSearchFaq(
  queryEmbeddingText: string,
  viewer: ViewerRoles,
  limit: number,
): Promise<RawHit[]> {
  const { canAdmin, canPm, canMember } = viewerTierFlags(viewer);
  return prisma.$queryRaw<RawHit[]>`
    SELECT "entry_id" AS entry_id,
           1 - (("content_embedding" <=> ${queryEmbeddingText}::vector) / 2) AS score
    FROM "faq_embeddings"
    WHERE ("requires_admin" = false OR ${canAdmin}::boolean)
      AND ("requires_project_pm" = false OR ${canPm}::boolean)
      AND ("requires_project_member" = false OR ${canMember}::boolean)
    ORDER BY "content_embedding" <=> ${queryEmbeddingText}::vector
    LIMIT ${limit}
  `;
}

/**
 * `guide_embeddings` から上位 K 件を取得する。設計は pgvectorSearchFaq と同型。
 */
async function pgvectorSearchGuide(
  queryEmbeddingText: string,
  viewer: ViewerRoles,
  limit: number,
): Promise<RawHit[]> {
  const { canAdmin, canPm, canMember } = viewerTierFlags(viewer);
  return prisma.$queryRaw<RawHit[]>`
    SELECT "entry_id" AS entry_id,
           1 - (("content_embedding" <=> ${queryEmbeddingText}::vector) / 2) AS score
    FROM "guide_embeddings"
    WHERE ("requires_admin" = false OR ${canAdmin}::boolean)
      AND ("requires_project_pm" = false OR ${canPm}::boolean)
      AND ("requires_project_member" = false OR ${canMember}::boolean)
    ORDER BY "content_embedding" <=> ${queryEmbeddingText}::vector
    LIMIT ${limit}
  `;
}

// ================================================================
// 公開関数: RAG 検索本体
// ================================================================

export interface SearchHelpContentInput {
  /** ユーザ質問文 (chat-input から渡る生の文字列。先頭末尾 trim 済前提) */
  query: string;
  /** 課金記録 + tenant 月 100 回上限カウントの対象 */
  tenantId: string;
  /** ApiCallLog.userId 用 (audit) */
  userId: string;
  /** 権限 defense-in-depth で必須 */
  viewer: ViewerRoles;
  /** 上位件数 (default HELP_SEARCH_DEFAULT_LIMIT) */
  limit?: number;
}

/**
 * ヘルプチャット RAG 検索のメインエントリポイント。
 *
 * フロー:
 *   1. `generateBatchEmbeddings(query, inputType='query')` でクエリ embedding 生成
 *      - 1 ApiCallLog (`featureUnit='help-chat-embedding'`、costJpy=0)
 *      - 失敗時は `degraded: true` で空 hits を返す (route 側で fallback)
 *   2. FAQ / Guide の pgvector 検索を **並列** で実行 (Promise.all)
 *      - 各テーブル top-K (= limit) を独立に取得、後で merge & re-sort
 *      - SQL 段で `requires_admin` / `requires_project_pm` を権限フィルタ (Layer 1)
 *   3. 結果を score 降順で merge し、上位 `limit` 件に削減
 *   4. **defense-in-depth Layer 2**: `getFaqEntriesForRole(viewer)` /
 *      `getGuideStepsForRole(viewer)` で許可された id 集合と intersect。
 *      SQL の denormalize flag が drift しても TS 側で再ガード。
 *   5. 各 hit の snapshot を `getFaqEntryById` / `getGuideStepById` から
 *      **config 側 (source-of-truth)** で再取得。DB snapshot は drift 検知時の
 *      予備 (= deploy 直後の乖離瞬間でも回答品質維持) で、優先順位は config > DB。
 *
 * **fail-safe**: embedding 生成失敗 / DB 接続失敗のいずれも throw せず、
 * `degraded: true` で返す (= ヘルプチャット全体を落とさない)。
 */
export async function searchHelpContent(
  input: SearchHelpContentInput,
): Promise<SearchHelpContentResult> {
  const limit = input.limit ?? HELP_SEARCH_DEFAULT_LIMIT;
  const query = input.query.trim();

  if (query.length === 0) {
    return {
      hits: [],
      costJpy: 0,
      requestId: null,
      degraded: true,
      degradedReason: 'empty_query',
    };
  }

  // Step 1: query embedding 生成 (1 ApiCallLog、cost=0、help-chat-embedding featureUnit)
  let embedResult: GenerateBatchEmbeddingsResult;
  try {
    embedResult = await generateBatchEmbeddings({
      texts: [query],
      featureUnit: 'help-chat-embedding',
      tenantId: input.tenantId,
      userId: input.userId,
      inputType: 'query',
    });
  } catch (err) {
    // generateBatchEmbeddings は通常 ok=false で返すが、想定外の throw は縮退扱い
    return {
      hits: [],
      costJpy: 0,
      requestId: null,
      degraded: true,
      degradedReason: `embed_throw:${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!embedResult.ok) {
    return {
      hits: [],
      costJpy: 0,
      requestId: null,
      degraded: true,
      degradedReason: `embed_failed:${embedResult.reason}`,
    };
  }

  const queryVector = embedResult.embeddings[0]!;
  const vectorText = `[${queryVector.join(',')}]`;

  // Step 2: FAQ / Guide を並列 pgvector 検索 (各 top-K)
  let faqRaw: RawHit[];
  let guideRaw: RawHit[];
  try {
    [faqRaw, guideRaw] = await Promise.all([
      pgvectorSearchFaq(vectorText, input.viewer, limit),
      pgvectorSearchGuide(vectorText, input.viewer, limit),
    ]);
  } catch (err) {
    // DB 障害時も縮退扱い (embedding は成功しているので cost は 0 のまま返す)
    return {
      hits: [],
      costJpy: embedResult.costJpy,
      requestId: embedResult.requestId,
      degraded: true,
      degradedReason: `pgvector_throw:${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Step 3 + 4: merge → defense-in-depth re-validate → snapshot 再取得
  const allowedFaqIds = new Set(
    getFaqEntriesForRole(input.viewer).map((e) => e.id),
  );
  const allowedGuideIds = new Set(
    getGuideStepsForRole(input.viewer).map((s) => s.id),
  );

  const merged: HelpSearchHit[] = [];

  for (const r of faqRaw) {
    if (!allowedFaqIds.has(r.entry_id)) continue; // ★ defense-in-depth Layer 2
    const entry = getFaqEntryById(r.entry_id);
    if (!entry) continue; // config から削除済 (DB drift): 表示不可
    merged.push({
      kind: 'faq',
      entryId: r.entry_id,
      snapshot: composeFaqContentText(entry), // config を真値として再構成
      score: Number(r.score),
    });
  }

  for (const r of guideRaw) {
    if (!allowedGuideIds.has(r.entry_id)) continue; // ★ defense-in-depth Layer 2
    const step = getGuideStepById(r.entry_id);
    if (!step) continue;
    merged.push({
      kind: 'guide',
      entryId: r.entry_id,
      snapshot: composeGuideContentText(step),
      score: Number(r.score),
    });
  }

  merged.sort((a, b) => b.score - a.score);
  const hits = merged.slice(0, limit);

  return {
    hits,
    costJpy: embedResult.costJpy,
    requestId: embedResult.requestId,
    degraded: false,
  };
}

/**
 * RAG 検索結果を LLM プロンプトに注入する `参考情報` セクションを組み立てる。
 *
 * 形式 (sourceFaqIds / sourceGuideStepIds 復元のため id を明示):
 *   ```
 *   ## 参考情報 (関連 FAQ / 使い方ガイド)
 *
 *   [faq:billing-cycle] (score: 0.82)
 *   Q: いつ請求されますか？
 *   A: 月末締め → 翌月 25 日...
 *
 *   [guide:create-project] (score: 0.61)
 *   タイトル: プロジェクトを作成する
 *   手順: 画面左メニュー...
 *   ```
 *
 * 空配列の場合は「参考情報なし」を返す (LLM に「該当する FAQ がないので
 * 一般論で答えてはいけない」と伝えるため省略しない)。
 */
export function buildRagPromptSection(hits: readonly HelpSearchHit[]): string {
  if (hits.length === 0) {
    return '## 参考情報 (関連 FAQ / 使い方ガイド)\n\n該当する FAQ・使い方ガイドが見つかりませんでした。回答できる情報がない場合は無理に推測せず、その旨を伝えてください。';
  }
  const blocks = hits.map((h) => {
    const idTag = `${h.kind}:${h.entryId}`;
    return `[${idTag}] (score: ${h.score.toFixed(2)})\n${h.snapshot}`;
  });
  return ['## 参考情報 (関連 FAQ / 使い方ガイド)', '', ...blocks].join('\n\n');
}
