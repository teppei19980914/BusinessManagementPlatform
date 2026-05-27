-- 2026-06-01 ADR-0022: Embedding 機能の従量課金導入 (Expert/Pro のみ ¥1/call、Beginner 無料維持)
--
-- 背景:
--   - 旧仕様 (ADR-0019 / 2026-05-24): Embedding 系 (knowledge / risk-issue / retrospective / memo /
--     chat-semantic-search / external-import / attachment) は全プラン無料・無制限。
--   - 実コスト構造の再評価: Voyage voyage-4-lite は ¥0.036/call の実コストで月 200M tokens の無料枠あり。
--     しかし無料枠を食い潰すと事業者損失リスクがあり、また「課金経路を最初から仕込んでおきたい」
--     (= Stripe-ready 設計) 要件から、Expert/Pro プランで ¥1/call の従量課金を導入する。
--   - Beginner プランは「90 日完全無料」の訴求を保つため Embedding も ¥0 維持。
--   - embedding-backfill (= 月初 cron 自動リカバリ) は「ユーザ非起動の修復処理」のため全プラン ¥0 維持。
--     これは「不当請求」回避のための重要設計判断 (UX/信頼関係への直接影響を避ける)。
--
-- 対象:
--   - Tenant テーブル: 当月の Embedding 呼出回数 / 課金額をリアルタイム追跡する counter カラムを追加。
--   - Tenant テーブル: Stripe Subscription Item ID (embedding 用) を追加。リリース時は使用しないが、
--     将来 STRIPE_PRICE_EMBEDDING 環境変数を設定するだけでクレジットカード払いが自動的に動くよう仕込む。
--   - TenantMonthlyUsageHistory テーブル: 月初 cron が snapshot する際の Embedding 内訳列を追加。
--     既存履歴行 (= ADR-0022 適用前) は NULL で残し、後方互換性を確保。
--
-- 影響:
--   - 全カラム NULLABLE (Stripe Item) or DEFAULT 0 (counter) のため、既存データに影響なし。
--   - 既存の課金経路 (project-upsert / suggestion-explanation / db-capacity-overage / storage-file-overage)
--     は currentMonthApi* に集計され、本 migration では一切変更しない。
--   - リリース時点で credit_card 払い未対応のため、stripe_subscription_item_embedding_id は常に NULL。
--     将来 Stripe 有効化時に completeStripeSetup が値をセットする。
--
-- 注意事項:
--   - 本 migration 後、コード側で billing-feature-units.ts の 4 階層化と withMeteredLLM の cost 分岐が
--     PR-A/B で一緒にデプロイされる必要がある。schema だけ migration して code が未デプロイの状態だと
--     ApiCallLog のみ記録されるが counter は不変 (= 表示が ApiCallLog SUM ベースで真値、設計通り)。
--
-- ロールバック手順:
--   1. ALTER TABLE tenants DROP COLUMN current_month_embedding_call_count;
--   2. ALTER TABLE tenants DROP COLUMN current_month_embedding_cost_jpy;
--   3. ALTER TABLE tenants DROP COLUMN stripe_subscription_item_embedding_id;
--   4. ALTER TABLE tenant_monthly_usage_history DROP COLUMN embedding_call_count;
--   5. ALTER TABLE tenant_monthly_usage_history DROP COLUMN embedding_cost_jpy;
--   6. アプリ側コードも同時にロールバック (`prisma migrate resolve --rolled-back`)。
--
-- 関連:
--   - ADR: docs/adr/0022-embedding-usage-based-billing.md
--   - 課金経路: src/lib/llm/metered.ts (withMeteredLLM cost 分岐), src/services/billing-aggregation.service.ts
--   - 単価: src/config/embedding-pricing.ts (resolveEmbeddingCostJpy)
--   - feature units: src/config/billing-feature-units.ts (4 階層 + EMBEDDING_BACKFILL は free)
--   - Stripe-ready: src/lib/stripe.ts (STRIPE_METER_EVENT_NAMES.embedding, STRIPE_PRICE_EMBEDDING optional)

-- ============================================================
-- §1. Tenant テーブル: Embedding 系の当月 counter
-- ============================================================

-- 現在の当月呼出回数 (Embedding 系)。全プランで increment、Beginner も件数記録 (UI 表示用)。
-- embedding-backfill は対象外 (= ApiCallLog のみ記録、本 counter には加算しない)。
ALTER TABLE tenants
  ADD COLUMN current_month_embedding_call_count INTEGER NOT NULL DEFAULT 0;

-- 現在の当月課金額 (円整数)。Beginner=0 / Expert=件数×¥1 / Pro=件数×¥1。
-- feedback_billing_invariant: ApiCallLog SUM = 本カラム = CSV = 請求書 の整合性必須。
ALTER TABLE tenants
  ADD COLUMN current_month_embedding_cost_jpy INTEGER NOT NULL DEFAULT 0;

-- ============================================================
-- §2. Tenant テーブル: Stripe Subscription Item (Embedding 用)
-- ============================================================

-- Stripe Subscription Item ID。STRIPE_PRICE_EMBEDDING 環境変数が設定されている場合のみ、
-- createSubscriptionForTenant が新規 Subscription 作成時に Item を追加し、本カラムにセットする。
-- リリース時は credit_card 払い未対応のため常に NULL。
-- 将来 Stripe 有効化時に env を設定するだけで自動的に値がセットされる Stripe-ready 設計。
ALTER TABLE tenants
  ADD COLUMN stripe_subscription_item_embedding_id VARCHAR(50);

-- ============================================================
-- §3. TenantMonthlyUsageHistory テーブル: 月初 snapshot の Embedding 内訳
-- ============================================================

-- 月初 cron が生成する snapshot の Embedding 呼出回数。
-- NULL 許容: ADR-0022 適用前の過去月の履歴行は NULL のまま残す (= 後方互換性確保)。
-- 過去月の super_admin / テナント請求 UI で「LLM / Embedding」の内訳を表示するために独立カラム化。
ALTER TABLE tenant_monthly_usage_history
  ADD COLUMN embedding_call_count INTEGER;

-- 月初 cron snapshot 時点の Embedding 課金額 (円整数)。
-- Beginner=0 / Expert=件数×¥1 / Pro=件数×¥1。NULL 許容理由は embedding_call_count と同じ。
ALTER TABLE tenant_monthly_usage_history
  ADD COLUMN embedding_cost_jpy INTEGER;

-- ============================================================
-- §4. インデックスは追加不要
-- ============================================================
--
-- 新規追加した 5 カラムはいずれも:
--   - 集計 SUM / COUNT 用 (= 主にダッシュボード KPI でテナント横断集計)
--   - WHERE 条件としては使われない (= テナント単位の集計は既存の idx_api_call_logs_tenant 経由)
-- のため、追加インデックスは作らない (= 不要な書き込み負荷を避ける)。
--
-- 必要になった場合は別 migration で `CREATE INDEX CONCURRENTLY` で本番停止なしに追加可能。
