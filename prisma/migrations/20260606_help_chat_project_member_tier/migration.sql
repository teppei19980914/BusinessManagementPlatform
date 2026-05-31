-- G1-perm (2026-05-31): たすきフクロウ ヘルプチャットの開示権限を 4 段化
--
-- 背景:
--   FAQ/使い方ガイドの開示段を all / tenant_admin / project_pm の 3 段から
--   all / project_member / project_pm / tenant_admin の 4 段に拡張する。
--   「課題・リスク・ナレッジ作成などの作業者向け操作手順」を project_member
--   (member 以上) に限定し、viewer のみ / 未所属ユーザには開示しない (最小権限)。
--   実権限は src/lib/permissions/check-permission.ts の ROLE_PERMISSIONS に基づく。
--
-- 設計:
--   - requires_project_member を denormalize 列として追加 (既存の
--     requires_admin / requires_project_pm と同型)。各エントリは高々 1 フラグ true。
--   - 階層内包 (admin ⊇ pm ⊇ member ⊇ all) は SQL では viewerTierFlags の
--     canAdmin / canPm / canMember を渡して表現する (help-search.service.ts)。
--   - permission 複合インデックスを新列込みで張り直す。
--
-- ロールバック方針: DROP COLUMN は安全 (RAG 権限フィルタが 3 段に戻るだけ)。

ALTER TABLE "faq_embeddings"
  ADD COLUMN "requires_project_member" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "guide_embeddings"
  ADD COLUMN "requires_project_member" BOOLEAN NOT NULL DEFAULT false;

DROP INDEX IF EXISTS "idx_faq_embeddings_permission";
CREATE INDEX "idx_faq_embeddings_permission"
  ON "faq_embeddings"("requires_admin", "requires_project_pm", "requires_project_member");

DROP INDEX IF EXISTS "idx_guide_embeddings_permission";
CREATE INDEX "idx_guide_embeddings_permission"
  ON "guide_embeddings"("requires_admin", "requires_project_pm", "requires_project_member");
