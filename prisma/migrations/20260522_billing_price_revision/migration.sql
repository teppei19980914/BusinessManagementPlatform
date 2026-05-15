-- 2026-05-15: per-API-call 単価の改定 (Expert ¥10 → ¥5 / Pro ¥30 → ¥15)
--
-- 背景:
--   - 旧仕様 (¥10 / ¥30) は粗利 85% で運用上問題なかったが、ユーザ視点で「1 操作 ¥30 は高い」
--     という心理的ハードルが発覚 (= 創業者ヒアリングと初期 UX 検証)
--   - 半額化で粗利 73-75% を維持しつつ、競合 (Notion AI 等の月額 ¥1,500-3,000/seat) と比較しても
--     圧倒的に attractive な価格水準にする
--   - ワーストケース (Anthropic 値上げ 2 倍) でも 50%+ の粗利を維持できるため事業継続性は担保される
--
-- 対象:
--   - 旧 default 値 (¥10 / ¥30) のままのテナント = 全テナント (v1 単一テナント運用のため)
--   - 既にカスタム価格が設定されているテナント (Enterprise 個別契約等) は触らない
--
-- 影響:
--   - 月途中で実行される場合: 既に発生した ApiCallLog の costJpy は変更されず、本 SQL 実行以降の
--     新規 call から新単価が適用される。`Tenant.currentMonthApiCostJpy` は新旧単価の合算となるが、
--     `ApiCallLog.costJpy` で個別 call ごとに正確な単価が記録済のため請求書発行時の正本データには
--     影響しない (= mid-month の単価変更を許容)。
--   - 将来の Stripe Metered Billing 連携時は、Stripe Price ID 側にも反映する必要あり
--     (本 PR では Stripe Price 設定は別の運用作業として super_admin が手動で実施)。

-- 既存テナントの単価を新仕様にアップデート (旧 default 値のものだけが対象)
UPDATE tenants
SET price_per_call_haiku = 5
WHERE price_per_call_haiku = 10;

UPDATE tenants
SET price_per_call_sonnet = 15
WHERE price_per_call_sonnet = 30;

-- @default(...) の Prisma schema 変更を DB 側にも反映
ALTER TABLE tenants ALTER COLUMN price_per_call_haiku SET DEFAULT 5;
ALTER TABLE tenants ALTER COLUMN price_per_call_sonnet SET DEFAULT 15;
