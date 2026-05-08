-- Knowledge.isSampleData フラグ追加 (2026-05-08)
--
-- 目的:
--   default-tenant に投入される SEED_KNOWLEDGE を「サンプルデータ」として識別。
--   全ナレッジ画面 (`/knowledge`) では非表示、super_admin role は bypass で表示・編集可。
--   Project.isSampleData (PR-X5) と同じ運用パターン。
--
-- 関連:
--   - schema: prisma/schema.prisma Knowledge モデル
--   - seed: prisma/seed-suggestion.ts (SEED_KNOWLEDGE 投入時に true 設定)
--   - service: src/services/knowledge.service.ts (isSampleData=false フィルタ)
--   - 教訓: docs/developer-guide/REFERENCE.md §5.59 (migration 冪等化)

ALTER TABLE "knowledges"
  ADD COLUMN IF NOT EXISTS "is_sample_data" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS "idx_knowledges_is_sample_data"
  ON "knowledges"("is_sample_data");
