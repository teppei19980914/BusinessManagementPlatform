-- 2026-06-02 PR-1 perf: 一覧画面の高頻度クエリ向けの複合 index を追加
--
-- 背景:
--   /projects 一覧は `WHERE tenant_id = ? AND deleted_at IS NULL AND status = ?` の組合せ、
--   /knowledge 一覧は `WHERE tenant_id = ? AND visibility = 'public' ORDER BY created_at DESC`
--   が頻出する。現状は tenantId 単独 / status 単独 / visibility 単独しか index がなく、
--   PostgreSQL planner が二度スキャン + マージする plan を選びがちで、テナント内データが
--   増えるほど線形に遅くなる。
--
-- 設計:
--   - projects: (tenant_id, status) 複合 index を追加 (idx_projects_tenant_status)。
--     deleted_at は partial index 対象外 (NULL 比較は B-Tree で効きづらい) のため列に含めず、
--     アプリ側の WHERE 句で従来通りフィルタする。
--   - knowledges: (tenant_id, visibility, created_at) の 3 列複合 index を追加
--     (idx_knowledges_tenant_visibility_created)。ORDER BY created_at DESC まで一括で
--     index scan できる構成。
--
-- 影響:
--   - 既存 index は残置 (ピンポイントクエリでは引き続き使われる)。
--   - CONCURRENTLY を使わない通常 CREATE INDEX (本番テーブルロックは数秒オーダー、Pre-release
--     フェーズでサービス影響軽微)。
--   - ロールバックは DROP INDEX で復帰可能。

CREATE INDEX IF NOT EXISTS "idx_projects_tenant_status"
  ON "projects" ("tenant_id", "status");

CREATE INDEX IF NOT EXISTS "idx_knowledges_tenant_visibility_created"
  ON "knowledges" ("tenant_id", "visibility", "created_at");
