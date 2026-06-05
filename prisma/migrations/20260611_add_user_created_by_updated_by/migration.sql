-- 2026-06-03: User に作成者/更新者 (created_by / updated_by) を追加。
-- 用途: ユーザ管理一覧 (/admin/users) の監査列「作成者・更新者」表示。
-- 設計: User は自己参照 FK を避ける方針のため、リレーションは張らず操作者の UUID のみ保持する。
--   氏名は listUsers が自テナント User をバルク参照して解決する (customer.service と同方式)。
--   既存ユーザは操作者の記録が無いため NULL のまま (UI では「—」表示)。バックフィルしない。

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "created_by" UUID;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "updated_by" UUID;
