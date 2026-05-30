-- ADR-0030 (2026-05-30): Embedding 月次予算上限の導入 + Beginner Embedding 100 件試用上限
--
-- 背景:
--   ADR-0022 で Embedding を従量課金化 + ADR-0029 で単価 ¥1 → ¥5 改定したため、
--   Expert/Pro テナントの Embedding 月次費用が無視できない規模になった。
--   既存 monthlyBudgetCapJpy は LLM_BILLABLE のみ判定対象だったため、Embedding 用に
--   個別の予算上限カラムを追加し、テナント管理者が自己設定できるようにする。
--
-- 設計判断:
--   - **専用カラム化**: 既存 monthlyBudgetCapJpy (LLM 用) と分離。理由は (1) 課金対象の
--     featureUnit 階層が完全に異なる (LLM_BILLABLE vs EMBEDDING_BILLABLE)、(2) 単価が
--     大きく異なる (Haiku ¥10 / Sonnet ¥15 vs Embedding ¥5) ため共通の閾値では運用しづらい、
--     (3) UI 上でも独立した設定欄として提示する (使用量タブ「Embedding 生成回数」直下)。
--   - **Beginner は NULL 強制**: 入力は許容するが API 層で BEGINNER_EMBEDDING_BUDGET_NOT_ALLOWED
--     で拒否 (= 既存 monthlyBudgetCapJpy の BEGINNER_BUDGET_NOT_ALLOWED と同パターン)。
--     Beginner Embedding は cost=0 のため金額上限が意味を持たず、別の試用上限 (= 100 件)
--     で UX を保証する設計。
--   - **TenantMonthlyUsageHistory snapshot は追加しない**: 既存 monthlyBudgetCapJpy も
--     履歴 snapshot 対象外 (= テナント設定であり利用量ではない) のため整合。
--
-- 関連:
--   - ADR: docs/adr/0030-embedding-monthly-budget-cap.md
--   - 真実源: prisma/schema.prisma Tenant.monthlyEmbeddingBudgetCapJpy
--   - 課金エンジン: src/lib/llm/metered.ts Step 4 (LLM cap と並列で Embedding cap 判定追加)
--   - UI: src/app/(dashboard)/settings/tenant/tenant-settings-client.tsx UsageSection
--   - Memory: feedback_billing_invariant (ApiCallLog SUM = 表示 = 請求 invariant)

ALTER TABLE "tenants"
ADD COLUMN "monthly_embedding_budget_cap_jpy" INTEGER;

COMMENT ON COLUMN "tenants"."monthly_embedding_budget_cap_jpy" IS
'ADR-0030: Embedding 系 (EMBEDDING_BILLABLE_FEATURE_UNITS = 7 種) 用の月次予算上限 (円整数)。NULL = 無制限。Beginner は意味を持たないため API 層で NULL 強制。Expert/Pro 任意設定 (テナント管理者画面で更新)。';
