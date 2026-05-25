-- 2026-05-24 ADR-0019: 課金対象を BILLABLE_FEATURE_UNITS に限定 + Expert ¥10 / Beginner 50 件
--
-- 背景:
--   - 旧仕様 (ADR-0002 / 2026-05-15) は全 LLM/Embedding 呼出を課金対象としていたが、
--     実コスト構造を再検証した結果:
--       * Embedding (Voyage voyage-4-lite): ¥0.036/call、月 200M tokens 無料枠あり
--       * LLM (Claude Haiku 4.5): ¥1.875/call
--       * LLM (Claude Sonnet 4.6): ¥5.625/call
--     Embedding は LLM の 1/50〜1/150 のコストで、実運用スケールでは「実コスト ¥0」で運用可能。
--   - これに合わせ、課金対象を「LLM 実コストが発生する操作」のみに限定:
--       * project-upsert (auto-tag LLM + embedding 集約)
--       * suggestion-explanation (なぜ機能 / Pro 限定 LLM)
--       * auto-tag-extract (スタンドアロン auto-tag / 予約)
--     上記以外の featureUnit (knowledge-embedding / chat-semantic-search / *-embedding-backfill /
--     external-import-embedding 等) は全プラン無料化。
--   - Beginner 月次上限: 課金対象縮小に合わせ 100 → 50 件 (project-upsert のみカウント)。
--   - Expert 単価: 課金対象縮小の補填として ¥5 → ¥10 へ (ADR-0019 §収益影響参照)。
--   - Pro 単価: ¥15 据置 (ADR-0002 と同値)。
--
-- 対象:
--   - 旧 default 値 (¥5 / 100) のままのテナント = 全テナント (v1 単一テナント運用のため)。
--     default-tenant と management テナントが該当。
--   - 既にカスタム価格が設定されているテナント (Enterprise 個別契約等) は触らない (将来の拡張に備え)。
--
-- 影響:
--   - 月途中で実行される場合: 既に発生した ApiCallLog の costJpy は変更されず、本 SQL 実行以降の
--     新規 call から新単価が適用される。`Tenant.currentMonthApiCostJpy` は新旧単価の合算となるが、
--     `ApiCallLog.costJpy` で個別 call ごとに正確な単価が記録済のため請求書発行時の正本データには
--     影響しない (= mid-month の単価変更を許容、ADR-0002 と同じ取り扱い)。
--   - Stripe Metered Billing 連携: 既存 Meter Event 名 (tasukiba_haiku_api_call /
--     tasukiba_sonnet_api_call) は据置。新 Haiku Price (¥10/call) を Stripe Dashboard で発行し、
--     STRIPE_PRICE_HAIKU 環境変数を新 Price ID に切替える運用作業を別途実施 (Phase 11)。
--
-- ロールバック手順:
--   1. UPDATE tenants SET price_per_call_haiku = 5 WHERE price_per_call_haiku = 10;
--   2. UPDATE tenants SET beginner_monthly_call_limit = 100 WHERE beginner_monthly_call_limit = 50;
--   3. ALTER TABLE tenants ALTER COLUMN price_per_call_haiku SET DEFAULT 5;
--   4. ALTER TABLE tenants ALTER COLUMN beginner_monthly_call_limit SET DEFAULT 100;
--   5. アプリ側コード変更も同時にロールバックすること (`prisma migrate resolve --rolled-back`)。

-- ============================================================
-- §1. 既存テナントの単価更新 (旧 default 値のものだけが対象)
-- ============================================================

-- Expert / Beginner の Haiku 単価: ¥5 → ¥10
UPDATE tenants
SET price_per_call_haiku = 10
WHERE price_per_call_haiku = 5;

-- Pro の Sonnet 単価は据置 (= 15)。書き換えなし。

-- ============================================================
-- §2. Beginner 月次上限の更新 (100 → 50)
-- ============================================================

UPDATE tenants
SET beginner_monthly_call_limit = 50
WHERE beginner_monthly_call_limit = 100;

-- ============================================================
-- §3. @default(...) を DB 側にも反映 (新規テナント作成時の初期値)
-- ============================================================

ALTER TABLE tenants ALTER COLUMN price_per_call_haiku SET DEFAULT 10;
ALTER TABLE tenants ALTER COLUMN beginner_monthly_call_limit SET DEFAULT 50;

-- price_per_call_sonnet の DEFAULT は 15 のまま据置 (本 migration では変更なし)。
