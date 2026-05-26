-- feat/asset-assignee-expansion (2026-05-26):
--   Memo に「担当者 (assignee_id)」を追加。memo は visibility='private' のとき他人からは
--   そもそも参照不可だが、'public' 化した memo の引継ぎ運用 (作成者 A → 担当者 B) を
--   可能にするため。
--
-- 注意 (service 層 enforcement):
--   - private memo に他人を assignee 指定すると、assignee は memo を参照不可になるため
--     service 層 (memo.service.ts) で「assigneeId が他人 かつ visibility='private'」を拒否する
--   - assignee 自身が visibility を切り替えるケースを想定しない設計 (= 作成者の最終決定権)
--
-- 関連: docs/business/AUTHORIZATION_MATRIX.md / docs/design/DATA_MODEL.md
ALTER TABLE "memos"
  ADD COLUMN "assignee_id" UUID;

ALTER TABLE "memos"
  ADD CONSTRAINT "memos_assignee_id_fkey"
  FOREIGN KEY ("assignee_id") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "idx_memos_assignee" ON "memos"("assignee_id");
