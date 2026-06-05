-- 2026-06-05 (feat/starter-data-import): seed_data_enabled カラムを撤去する。
-- 背景:
--   旧 seedDataEnabled は「提案エンジンに管理テナント (MANAGEMENT_TENANT_ID) のシードを越境参照させるか」の
--   テナント別 toggle だった。スターターデータを「取込ボタン」で各テナントに複製する方式 (is_seed_sample) に
--   変更し、提案/チャットは常に自テナントのみを参照する単一テナント化を行ったため、本カラムは不要になった。
-- 安全性:
--   - カラム削除は破壊的だが、参照コード (suggestion.service / chat-search.service / tenant-self.service /
--     api/tenants/me / 設定画面 toggle) はすべて撤去済み。
--   - IF EXISTS で冪等。値は提案範囲制御のみに使われ、課金・認証・テナント帰属には無関係 (データ損失なし)。

ALTER TABLE "tenants" DROP COLUMN IF EXISTS "seed_data_enabled";
