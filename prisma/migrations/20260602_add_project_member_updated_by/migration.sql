-- 2026-06-02: ProjectMember に updated_by を追加。
--   一覧「更新者」表示用。ロール変更 (updateMemberRole) 時に変更実行者を記録する。
--   追加時点では未更新のため null (assigned_by = 作成者 として既存カラムを利用)。
ALTER TABLE "project_members" ADD COLUMN "updated_by" UUID;
