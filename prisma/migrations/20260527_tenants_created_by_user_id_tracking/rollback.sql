-- Rollback for 20260527_tenants_created_by_user_id_tracking
--
-- 注意: 列削除すると本番運用中の 3 層判定が動作不能になる。
-- 必ず application 側で「列が存在しない場合のフォールバック動作」(= 旧 4 条件判定への巻き戻し)
-- をデプロイ済みの状態でのみ実行すること。

DROP INDEX IF EXISTS "idx_tenants_created_by_user_id_partial";

ALTER TABLE "tenants"
  DROP COLUMN IF EXISTS "created_by_user_id";
