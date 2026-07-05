/**
 * 課金分類 featureUnit 定義 (ADR-0019 / ADR-0020 / ADR-0021 / ADR-0022 統合)
 *
 * 役割:
 *   ApiCallLog.featureUnit 値の課金分類を **4 階層** で一元定義する。`withMeteredLLM` と
 *   billing-aggregation / monthly-reset / super-admin / api-usage-recalc 等の集計経路が
 *   本ファイルを単一の真実源として参照する。
 *
 * 4 階層の分類 (ADR-0022 / 2026-06-01 後):
 *   1. **LLM_BILLABLE_FEATURE_UNITS** (= 既存): Claude API を呼ぶ操作。plan 別単価
 *      (resolveCostForPlan: Beginner ¥0 / Expert ¥10 / Pro ¥15)。Beginner 月次 50 件上限と
 *      monthlyBudgetCap の判定対象。Stripe queue は haiku/sonnet event 名で投入。
 *      → project-upsert, suggestion-explanation, auto-tag-extract
 *   2. **EMBEDDING_BILLABLE_FEATURE_UNITS** (NEW / ADR-0022): Voyage embedding API を呼ぶ
 *      ユーザ起動操作。plan 別単価 (resolveEmbeddingCostJpy: Beginner ¥0 / Expert ¥5 / Pro ¥5、ADR-0029)。
 *      Beginner 上限 / budget cap 判定対象外 (= 既存上限ロジック不変)。Stripe queue は
 *      embedding event 名で投入 (cost > 0 のときのみ = Beginner はスキップ)。
 *      → knowledge-embedding, risk-issue-embedding, retrospective-embedding, memo-embedding,
 *         chat-semantic-search, external-import-embedding, attachment-embedding
 *   3. **STORAGE_OVERAGE_FEATURE_UNITS** (= 既存): 月初 cron が月次集約で 1 件 INSERT する
 *      従量課金。`withMeteredLLM` 経由ではなく `tenant-monthly-reset.service.ts` が直接 INSERT。
 *      → db-capacity-overage, storage-file-overage
 *   4. **EMBEDDING_BACKFILL_FEATURE_UNITS** (NEW / ADR-0022, 明示的 free): 月初 cron 等の
 *      システム自動リカバリ処理 (= ユーザ非起動)。**全プランで ¥0 維持** が ADR-0022 の
 *      重要設計判断。ユーザが起動していない処理での課金は「不当請求」と感じられ
 *      UX/信頼関係に直接影響するため、明示的に free 扱いを定義する。
 *      → project-embedding-backfill, knowledge-embedding-backfill, risk-issue-embedding-backfill,
 *         retrospective-embedding-backfill, memo-embedding-backfill,
 *         idea-qa-embedding-backfill, idea-whiteboard-embedding-backfill, idea-voting-embedding-backfill
 *
 * 派生定数:
 *   - **BILLABLE_FEATURE_UNITS** = LLM + EMBEDDING + STORAGE_OVERAGE の union (= 全課金対象)。
 *     `billing-aggregation.service.ts` が invoice/bank_transfer テナントの月次請求集計で参照。
 *     `api-usage-recalc.service.ts` も同じく drift 検知用に参照。
 *
 * 設計判断 (ADR-0019/0022):
 *   - **中央定義**: featureUnit 値が散在すると drift (= 課金対象を変えたつもりが Stripe には旧定義で
 *     投入され続けた) を起こすため、本ファイルで一括管理する。
 *   - **ApiCallLog は全 featureUnit 記録**: 監査 / 利用分析 / fair use limit のカウント / 将来の
 *     課金復活時の根拠データに使う。記録自体は省略しない。
 *   - **未知の featureUnit は安全側で free 扱い**: 想定外の文字列が来た場合、誤って課金しない方が
 *     安全 (= 顧客信頼の方を優先)。想定外値の検出は ApiCallLog の featureUnit 集計監視で別途行う。
 *   - **EMBEDDING_BACKFILL を別配列にする理由**: 「無料」と「課金対象だが Beginner で ¥0」は
 *     似て非なる概念。前者はそもそも cost 計算経路に乗らず、後者は plan 依存。混在を避ける。
 *
 * 関連:
 *   - ADR-0019: docs/adr/0019-billable-feature-units-and-free-tier-expansion.md
 *   - ADR-0020: docs/adr/0020-db-capacity-usage-based-billing.md
 *   - ADR-0021: docs/adr/0021-file-storage-usage-based-billing.md
 *   - ADR-0022: docs/adr/0022-embedding-usage-based-billing.md
 *   - 課金エンジン: src/lib/llm/metered.ts (本配列の参照元)
 *   - LLM 単価: src/config/llm.ts resolveCostForPlan()
 *   - Embedding 単価: src/config/embedding-pricing.ts resolveEmbeddingCostJpy()
 *   - Fair use limit (Beginner プランの無料 call 暴走防止): src/services/fair-use-limit.service.ts
 *   - Memory: feedback_billing_invariant.md (ApiCallLog SUM = 表示 = 請求 invariant)
 */

/**
 * LLM (Claude API) を呼ぶ課金対象 featureUnit。plan 別単価 (resolveCostForPlan)。
 *
 * - `project-upsert`: プロジェクト作成/更新の auto-tag (LLM) + embedding を 1 ApiCallLog に集約。
 *   plan 依存単価で課金 (Beginner 上限カウント / Expert ¥10 / Pro ¥15)。
 * - `suggestion-explanation`: なぜ?機能 (Pro 限定の LLM 呼出)。Pro のみ ¥15/call で課金。
 * - `auto-tag-extract`: スタンドアロン auto-tag (= project-upsert の集約外で呼ばれる場合)。
 *   現状 project.service.ts の `extractTagsAndEmbedForProject` 経由のみ。将来単独利用に備える。
 *
 * これらは withMeteredLLM の **Beginner 50 件月次上限** と **monthlyBudgetCap 予測超過判定** の
 * 対象。counter は currentMonthApiCallCount / currentMonthApiCostJpy に increment される。
 */
export const LLM_BILLABLE_FEATURE_UNITS = [
  'project-upsert',
  'suggestion-explanation',
  'auto-tag-extract',
] as const;

export type LlmBillableFeatureUnit = (typeof LLM_BILLABLE_FEATURE_UNITS)[number];

/**
 * Embedding (Voyage API) を呼ぶ課金対象 featureUnit。plan 別単価 (resolveEmbeddingCostJpy)。
 * ADR-0022 (2026-06-01) で新設。
 *
 * 単価: Beginner=¥0 / Expert=¥5 / Pro=¥5 (ADR-0029 で ¥1 → ¥5 改定)
 *
 * - `knowledge-embedding`: Knowledge 作成・更新時の embedding 生成
 * - `risk-issue-embedding`: RiskIssue 作成・更新時の embedding 生成
 * - `retrospective-embedding`: Retrospective 作成・更新時の embedding 生成
 * - `memo-embedding`: Memo 作成・更新時の embedding 生成
 * - `chat-semantic-search`: チャット検索クエリの embedding 生成 (1 検索 = 1 call)
 * - `external-import-embedding`: CSV 一括インポート時の embedding 生成 (N 件取込 = 1 call、bulk 集約)
 * - `attachment-embedding`: 添付ファイル本文の意味検索用 embedding 生成
 * - `idea-qa-embedding`: 匿名FAQ スレッドのクローズ時 embedding 生成 (質問+全回答を結合)
 * - `idea-whiteboard-embedding`: ホワイトボードセッションのクローズ時 embedding 生成 (タイトル+説明+全付箋)
 * - `idea-voting-embedding`: 投票セッションのクローズ時 embedding 生成 (タイトル+説明+選択肢テキスト)
 *
 * 設計判断:
 *   - **bulk は 1 業務操作 = 1 call**: external-import-embedding は generateBatchEmbeddings で
 *     N 件処理しても 1 ApiCallLog = 1 課金単位 (= memory feedback_bulk_llm_call_unit.md)。
 *     100 件 CSV 取込でも ¥5 で済む UX 配慮 (= 1 業務操作 1 課金、ADR-0029)。
 *   - **Beginner は 90 日完全無料訴求保全**: resolveEmbeddingCostJpy('beginner') = 0 で
 *     LP 上の「資産入力・チャット検索は完全無料」が引き続き成立する。
 *   - **既存上限ロジックは不変**: Beginner 50 件月次上限と monthlyBudgetCap は LLM 系のみ判定。
 *     Embedding はチャット検索/資産入力に必須のため、これらの上限で止めない設計。
 *   - **Embedding 系の counter は独立**: currentMonthEmbeddingCallCount / currentMonthEmbeddingCostJpy
 *     に increment。全プランで件数記録 (Beginner は cost=0 でも件数は記録、UI 表示用)。
 *   - **Stripe queue 投入**: cost > 0 (= Expert/Pro) かつ credit_card テナントのみ。新 Meter event
 *     'tasukiba_embedding_call' で送信 (= STRIPE_METER_EVENT_NAMES.embedding)。
 */
export const EMBEDDING_BILLABLE_FEATURE_UNITS = [
  'knowledge-embedding',
  'risk-issue-embedding',
  'retrospective-embedding',
  'memo-embedding',
  'chat-semantic-search',
  'external-import-embedding',
  'attachment-embedding',
  'idea-qa-embedding',
  'idea-whiteboard-embedding',
  'idea-voting-embedding',
] as const;

export type EmbeddingBillableFeatureUnit = (typeof EMBEDDING_BILLABLE_FEATURE_UNITS)[number];

/**
 * 月初 cron が月次集約で 1 件 INSERT する従量課金 featureUnit。
 * `withMeteredLLM` 経由ではなく `tenant-monthly-reset.service.ts` が直接 INSERT する。
 *
 * - `db-capacity-overage` (ADR-0020 / 2026-05-25): DB 容量超過 ¥50/GB tier、月初 cron で
 *   前月 peak から quantity を算出し ApiCallLog INSERT。費用計算は
 *   `src/config/db-capacity-pricing.ts:calculateOverageJpy()`。
 * - `storage-file-overage` (ADR-0021 / 2026-05-26): ファイル添付ストレージ超過 ¥10/GB tier、
 *   同じく月初 cron で前月 peak から ApiCallLog INSERT。費用計算は
 *   `src/config/file-storage-pricing.ts:calculateFileStorageOverageJpy()`。
 */
export const STORAGE_OVERAGE_FEATURE_UNITS = [
  'db-capacity-overage',
  'storage-file-overage',
] as const;

export type StorageOverageFeatureUnit = (typeof STORAGE_OVERAGE_FEATURE_UNITS)[number];

/**
 * 月初 cron 等のシステム自動リカバリで生成される **明示的 free** な featureUnit。
 * ADR-0022 (2026-06-01) で導入。
 *
 * 設計判断:
 *   - これらは ユーザが起動していない 自動リカバリ処理 (= 失敗した embedding を月初に再生成)。
 *   - ユーザ視点では「自分が起こした覚えのない処理での請求」と感じられるため、Expert/Pro でも
 *     明示的に ¥0 維持する。「不当請求」リスクを避け UX/信頼関係を保つための重要設計判断。
 *   - 「無料」と「課金対象だが Beginner で ¥0」は別概念。前者は cost 計算経路に乗らず、後者は
 *     plan 依存。混在を避けるため別配列で定義し、`isEmbeddingBackfillFeatureUnit` で明示判定。
 *   - ApiCallLog には記録 (監査・Voyage 利用枠監視のため)、cost=0、counter 不変、Stripe queue 不投入。
 *
 * featureUnit は `${tableToFeatureUnit(table)}-backfill` で動的生成される
 * (= src/services/embedding-backfill.service.ts:140)。
 */
export const EMBEDDING_BACKFILL_FEATURE_UNITS = [
  'project-embedding-backfill',
  'knowledge-embedding-backfill',
  'risk-issue-embedding-backfill',
  'retrospective-embedding-backfill',
  'memo-embedding-backfill',
  'idea-qa-embedding-backfill',
  'idea-whiteboard-embedding-backfill',
  'idea-voting-embedding-backfill',
] as const;

export type EmbeddingBackfillFeatureUnit = (typeof EMBEDDING_BACKFILL_FEATURE_UNITS)[number];

/**
 * 全課金対象 featureUnit の union (= LLM + EMBEDDING + STORAGE_OVERAGE)。
 *
 * 用途:
 *   - `billing-aggregation.service.ts`: invoice/bank_transfer テナントの月次請求集計の filter
 *     (= `featureUnit: { in: [...BILLABLE_FEATURE_UNITS] }` で ApiCallLog の SUM を取る)
 *   - `api-usage-recalc.service.ts`: drift 検知の真値集計の filter
 *   - `super-admin.service.ts` getCrossTenantUsageSummary: 全テナント横断 KPI の filter
 *   - `super-admin.service.ts` deleteTenant 退会 snapshot: 真値集計の filter
 *
 * **EMBEDDING_BACKFILL は本 union に含まれない** (= free 扱い)。
 */
export const BILLABLE_FEATURE_UNITS = [
  ...LLM_BILLABLE_FEATURE_UNITS,
  ...EMBEDDING_BILLABLE_FEATURE_UNITS,
  ...STORAGE_OVERAGE_FEATURE_UNITS,
] as const;

export type BillableFeatureUnit = (typeof BILLABLE_FEATURE_UNITS)[number];

// ================================================================
// 型ガード判定関数
// ================================================================

/**
 * LLM 系課金対象かを判定 (= project-upsert / suggestion-explanation / auto-tag-extract)。
 *
 * `withMeteredLLM` は本関数が true のときのみ:
 *   - cost = resolveCostForPlan(plan) (plan 別単価)
 *   - currentMonthApiCallCount / currentMonthApiCostJpy を increment
 *   - Beginner 50 件月次上限 + monthlyBudgetCap を判定
 *   - Stripe queue に haiku/sonnet event で投入
 */
export function isLlmBillableFeatureUnit(
  featureUnit: string,
): featureUnit is LlmBillableFeatureUnit {
  return (LLM_BILLABLE_FEATURE_UNITS as readonly string[]).includes(featureUnit);
}

/**
 * Embedding 系課金対象かを判定 (= 7 種類のユーザ起動 embedding 操作)。
 * ADR-0022 (2026-06-01) で新設。
 *
 * `withMeteredLLM` は本関数が true のときのみ:
 *   - cost = resolveEmbeddingCostJpy(plan) (Beginner=0 / Expert=5 / Pro=5、ADR-0029)
 *   - currentMonthEmbeddingCallCount / currentMonthEmbeddingCostJpy を increment (全プラン件数記録)
 *   - Beginner 上限 / budget cap は **判定しない** (= 既存上限ロジック不変)
 *   - cost > 0 のとき Stripe queue に embedding event で投入 (Beginner はスキップ)
 */
export function isEmbeddingBillableFeatureUnit(
  featureUnit: string,
): featureUnit is EmbeddingBillableFeatureUnit {
  return (EMBEDDING_BILLABLE_FEATURE_UNITS as readonly string[]).includes(featureUnit);
}

/**
 * Storage 超過課金対象かを判定 (= db-capacity-overage / storage-file-overage)。
 *
 * これらは `withMeteredLLM` 経由ではなく月初 cron が直接 ApiCallLog INSERT するため、
 * 本関数は主に `billing-aggregation` / `api-usage-recalc` 等の集計経路で使用。
 */
export function isStorageOverageFeatureUnit(
  featureUnit: string,
): featureUnit is StorageOverageFeatureUnit {
  return (STORAGE_OVERAGE_FEATURE_UNITS as readonly string[]).includes(featureUnit);
}

/**
 * Embedding 自動リカバリ (backfill cron) かを判定。ADR-0022 (2026-06-01) で新設。
 *
 * `withMeteredLLM` は本関数が true のときも:
 *   - cost = 0 (明示的 free、plan 不問)
 *   - counter 不変 (= currentMonthApi* / Embedding* いずれも増えない)
 *   - Stripe queue 不投入
 *   - ApiCallLog のみ記録 (監査・Voyage 利用枠監視用)
 *
 * 設計意図: ユーザが起動していない自動リカバリでの課金は「不当請求」と感じられるため
 * 明示的に free 扱いを保つ (UX/信頼関係保護)。
 */
export function isEmbeddingBackfillFeatureUnit(
  featureUnit: string,
): featureUnit is EmbeddingBackfillFeatureUnit {
  return (EMBEDDING_BACKFILL_FEATURE_UNITS as readonly string[]).includes(featureUnit);
}

/**
 * いずれかの課金対象 (= LLM / Embedding / Storage Overage) かを判定。
 *
 * 用途:
 *   - 既存コードの後方互換 (`isBillableFeatureUnit` を呼んでいる箇所が多数ある)。
 *   - 「課金対象 ApiCallLog の SUM を取る」集計経路で使用。
 *
 * 注意:
 *   - 本関数が true でも、実際の cost は plan / featureUnit で変動する (LLM は plan 別、Embedding は
 *     Beginner=0 / Expert=Pro=5 (ADR-0029)、Storage Overage は使用量から算出)。
 *   - billable/free の単純判定だけでは正しい単価が決まらない。cost 計算は metered.ts で行う。
 */
export function isBillableFeatureUnit(
  featureUnit: string,
): featureUnit is BillableFeatureUnit {
  return (BILLABLE_FEATURE_UNITS as readonly string[]).includes(featureUnit);
}

/**
 * 学習支援 (たすきフクロウ AI ヘルプチャット) 用の **明示的 free** featureUnit。
 * ADR-0027 (2026-05-29) で導入、ADR-0028 (2026-05-30) で RAG 用 embedding を追加。
 *
 * 設計判断:
 *   - 初心者ユーザがたすきばの使い方を学習するための機能で、運営側が学習コストとして
 *     吸収する想定。Beginner プラン (試用) でも気軽に質問できるよう全プラン無料とする
 *     ([[project_faq_drives_ai_accuracy]] / ADR-0027 / ADR-0028)。
 *   - withMeteredLLM 経由ではなく `/api/help/chat` route 内で直接 ApiCallLog INSERT し、
 *     Tenant.currentMonthHelpChatCount (新規カラム) で月次回数を独自管理する。
 *     既存の 4 階層分類 (LLM/EMBEDDING/STORAGE_OVERAGE/BACKFILL_FREE) には含めず、
 *     `BILLABLE_FEATURE_UNITS` union にも入れない (= 集計対象外)。
 *   - テナント単位月 100 回上限 (route 内で判定)。超過時は HTTP 429 +
 *     `fallbackToAccordion: true` を返し、UI が FAQ アコーディオン誘導にフォールバック。
 *   - 月次リセット (currentMonthHelpChatCount = 0) は tenant-monthly-reset.service.ts に
 *     PR6 以降で組み込む。PR5 時点では未実装 (TODO: ADR-0027 §関連参照)。
 *
 * featureUnit 一覧:
 *   - 'help-chat': ヘルプチャット 1 問答 (= LLM Claude Haiku 呼出)
 *   - 'help-chat-embedding' (ADR-0028 / 2026-05-30): RAG 用 query embedding 生成
 *      および FAQ/Guide コンテンツ embedding 生成 (Voyage AI 呼出)。テナント横断
 *      生成バッチ (scripts/generate-faq-embeddings.ts) も同 featureUnit で記録し、
 *      Voyage 200M tokens 無料枠の利用状況監視に使用する。
 *
 * 関連:
 *   - src/app/api/help/chat/route.ts (本 featureUnit を使う唯一の経路)
 *   - src/services/help-search.service.ts (RAG 検索本体)
 *   - scripts/generate-faq-embeddings.ts (FAQ/Guide embedding 一括生成、ADR-0028)
 *   - prisma/schema.prisma Tenant.currentMonthHelpChatCount
 *   - docs/developer-guide/FAQ_AND_OWL_CHAT_GUIDE.md §1.3
 *   - docs/adr/0028-help-chat-rag-migration.md
 */
export const LEARNING_FREE_FEATURE_UNITS = [
  'help-chat',
  'help-chat-embedding',
] as const;

export type LearningFreeFeatureUnit = (typeof LEARNING_FREE_FEATURE_UNITS)[number];

/**
 * 学習支援 featureUnit (= help-chat 等) かを判定。
 * 本関数が true の featureUnit は:
 *   - cost = 0 (全プラン無料)
 *   - BILLABLE_FEATURE_UNITS union に含まれない (= 集計対象外)
 *   - 専用 Counter (currentMonthHelpChatCount) で月次上限管理
 */
export function isLearningFreeFeatureUnit(
  featureUnit: string,
): featureUnit is LearningFreeFeatureUnit {
  return (LEARNING_FREE_FEATURE_UNITS as readonly string[]).includes(featureUnit);
}

/**
 * テナント単位月次上限 (help-chat の運営コスト管理用)。
 * ¥0.5/query × 100 回 = ¥50/月/テナント の運営コスト想定。
 */
export const HELP_CHAT_MONTHLY_LIMIT_PER_TENANT = 100;
