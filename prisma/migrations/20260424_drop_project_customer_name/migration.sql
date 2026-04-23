-- PR #111-2: Project.customer_name 列を廃止し customer_id を NOT NULL 化する
--
-- 前提: PR #111-1 (20260423_customers) 適用済みで、全 projects.customer_id が埋まっている。
--
-- 事前チェック (手動適用時、Supabase SQL Editor):
--   SELECT COUNT(*) FROM projects WHERE customer_id IS NULL;
--   -- 結果が 0 であることを確認してから本 SQL を実行する。
--   -- 0 でない場合は本 SQL は NOT NULL 制約付与で失敗するため、
--   -- 該当 project の customer_id を手動で埋めるか、論理削除済みかを確認する。
--
-- ロールバック: 本 migration のロールバックは以下:
--   ALTER TABLE projects ADD COLUMN customer_name VARCHAR(100);
--   UPDATE projects p SET customer_name = c.name FROM customers c WHERE c.id = p.customer_id;
--   ALTER TABLE projects ALTER COLUMN customer_name SET NOT NULL;
--   ALTER TABLE projects ALTER COLUMN customer_id DROP NOT NULL;
--   CREATE INDEX idx_projects_customer ON projects (customer_name);

-- ---------------- 1. customer_id を NOT NULL 化 ----------------
-- PR #111-1 時点では nullable だったが、併存期間終了につき NOT NULL 制約を追加。
-- NULL 行が残っていれば制約追加が失敗する (事前チェッククエリで保護)。
ALTER TABLE projects
  ALTER COLUMN customer_id SET NOT NULL;

-- ---------------- 2. customer_name 旧インデックス削除 ----------------
-- PR #111-1 では customer_name 検索用の複合 key として残していたが、
-- 列自体を削除するのでインデックスも廃止する。
DROP INDEX IF EXISTS idx_projects_customer;

-- ---------------- 3. customer_name 列削除 ----------------
-- 顧客管理は customers テーブル経由に完全移行。customer_name は冗長なので削除。
ALTER TABLE projects
  DROP COLUMN customer_name;

-- ---------------- 4. データ整合性検証 (手動) ----------------
-- 確認クエリ:
--   SELECT COUNT(*) AS total, COUNT(customer_id) AS with_cid FROM projects;
--   -- total == with_cid であること (customer_id は NOT NULL になったので常に一致するが念のため)
