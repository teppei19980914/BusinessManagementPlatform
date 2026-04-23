-- PR #111-1: 顧客管理テーブル新設 + Project への customer_id 導入
--
-- 方針:
--   - customers テーブルを新設、物理削除方針 (deleted_at 列を持たない)
--   - projects に customer_id 列を追加 (nullable)、FK ON DELETE SET NULL
--   - 既存 customer_name 列は本 PR では削除せず併存 (PR #111-2 で削除予定)
--   - 既存データの customer_name から customers を自動生成し、customer_id を埋める
--
-- 実行順序 (手動適用時、Supabase SQL Editor):
--   1. このファイル全体を 1 トランザクション相当で実行
--   2. 実行後 `SELECT COUNT(*) FROM customers;` で期待件数を確認
--   3. `SELECT COUNT(*) FROM projects WHERE customer_id IS NULL;` が 0 であることを確認
--
-- ロールバック: 本 migration のロールバックは以下:
--   ALTER TABLE projects DROP COLUMN customer_id;
--   DROP TABLE customers;

-- ---------------- 1. customers テーブル新設 ----------------
CREATE TABLE customers (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  name            VARCHAR(100) NOT NULL,
  department      VARCHAR(100),
  contact_person  VARCHAR(100),
  contact_email   VARCHAR(255),
  notes           TEXT,
  created_by      UUID         NOT NULL,
  updated_by      UUID         NOT NULL,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_customers_name ON customers (name);

-- ---------------- 2. 既存 projects.customer_name から customers を自動生成 ----------------
-- 同じ customer_name は 1 つの customer に集約する (unique 化)。
-- created_by / updated_by には、その顧客名を初めて登録した Project の created_by を流用
-- (初期化時点の責任所在を記録)。
-- deleted_at フィルタで、active な Project のみから customers を生成する方針も検討したが、
-- 論理削除された Project の customer も表示されるようにするため全 Project から抽出する。
INSERT INTO customers (id, name, created_by, updated_by, created_at, updated_at)
SELECT
  gen_random_uuid()                    AS id,
  t.customer_name                      AS name,
  t.earliest_created_by                AS created_by,
  t.earliest_created_by                AS updated_by,
  NOW()                                AS created_at,
  NOW()                                AS updated_at
FROM (
  SELECT
    customer_name,
    (SELECT created_by FROM projects p2
      WHERE p2.customer_name = p1.customer_name
      ORDER BY p2.created_at ASC LIMIT 1) AS earliest_created_by
  FROM projects p1
  GROUP BY customer_name
) t;

-- ---------------- 3. projects に customer_id 列追加 ----------------
ALTER TABLE projects
  ADD COLUMN customer_id UUID;

-- ---------------- 4. customer_name を customer_id に紐付け ----------------
UPDATE projects p
SET customer_id = c.id
FROM customers c
WHERE c.name = p.customer_name;

-- ---------------- 5. FK 制約追加 (ON DELETE SET NULL) ----------------
-- 論理削除済み Project も FK を持つ。Customer 物理削除時には customer_id を NULL に設定。
ALTER TABLE projects
  ADD CONSTRAINT fk_projects_customer
  FOREIGN KEY (customer_id) REFERENCES customers (id)
  ON DELETE SET NULL;

-- ---------------- 6. インデックス追加 ----------------
CREATE INDEX idx_projects_customer_id ON projects (customer_id);

-- ---------------- 7. データ整合性検証 (本 SQL の末尾で手動確認) ----------------
-- 期待:
--   - customers 件数 = DISTINCT customer_name 数
--   - projects.customer_id IS NOT NULL の件数 = 全 projects 件数
--
-- 確認クエリ (手動):
--   SELECT
--     (SELECT COUNT(*) FROM customers)                              AS customers_count,
--     (SELECT COUNT(DISTINCT customer_name) FROM projects)           AS distinct_names,
--     (SELECT COUNT(*) FROM projects WHERE customer_id IS NOT NULL) AS projects_with_cid,
--     (SELECT COUNT(*) FROM projects)                                AS projects_total;
--   -- customers_count == distinct_names かつ projects_with_cid == projects_total なら成功
