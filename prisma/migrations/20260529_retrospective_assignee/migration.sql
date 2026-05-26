-- feat/asset-assignee-expansion (2026-05-26):
--   Retrospective に「担当者 (assignee_id)」を追加。Knowledge.assigneeId と同設計。
--
-- 関連: docs/business/AUTHORIZATION_MATRIX.md / docs/design/DATA_MODEL.md
ALTER TABLE "retrospectives"
  ADD COLUMN "assignee_id" UUID;

ALTER TABLE "retrospectives"
  ADD CONSTRAINT "retrospectives_assignee_id_fkey"
  FOREIGN KEY ("assignee_id") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "idx_retro_assignee" ON "retrospectives"("assignee_id");
