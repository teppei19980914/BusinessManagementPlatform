-- feat/asset-assignee-expansion (2026-05-26):
--   Knowledge に「担当者 (assignee_id)」を追加。認可モデルを「作成者本人のみ編集可」から
--   「作成者 OR 担当者 が編集可」に拡張するため。
--
-- 設計:
--   - assignee_id は nullable (= 担当者未設定なら従来通り作成者のみ編集可)
--   - ON DELETE SET NULL: 担当者の User 物理削除時に Knowledge は残し、担当を解除
--   - 既存行は NULL のまま (= 後方互換: 認可拡張は assignee 指定後のみ有効)
--   - idx_knowledges_assignee: 担当 Knowledge 一覧画面の絞込み高速化
--
-- 関連:
--   - schema: prisma/schema.prisma Knowledge.assigneeId
--   - service: src/services/knowledge.service.ts (update/delete auth 拡張)
--   - validator: src/lib/validators/knowledge.ts (assigneeId 受入れ)
--   - docs: docs/business/AUTHORIZATION_MATRIX.md / docs/design/DATA_MODEL.md
ALTER TABLE "knowledges"
  ADD COLUMN "assignee_id" UUID;

ALTER TABLE "knowledges"
  ADD CONSTRAINT "knowledges_assignee_id_fkey"
  FOREIGN KEY ("assignee_id") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "idx_knowledges_assignee" ON "knowledges"("assignee_id");
