-- P-3 (2026-05-08): SuggestionExplanation テーブルを追加
--
-- 目的:
--   提案候補ごとの「なぜ関連するのか」説明文を LLM (Pro=Sonnet / Beginner-Expert=Haiku)
--   で生成し、(projectId, candidateKind, candidateId) で永続キャッシュする。
--   Lazy 生成 (ユーザがクリック時のみ) + DB キャッシュで再課金を防ぐ。
--
-- 詳細仕様: docs/roadmap/V1_FINAL_TASKS.md P-3
-- 関連: src/services/suggestion-explanation.service.ts
--       src/app/api/projects/[projectId]/suggestions/explain/route.ts

CREATE TABLE "suggestion_explanations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "candidate_kind" VARCHAR(20) NOT NULL,
    "candidate_id" UUID NOT NULL,
    "explanation" TEXT NOT NULL,
    "model_name" VARCHAR(60) NOT NULL,
    "cost_jpy" INTEGER NOT NULL,
    "generated_by" UUID NOT NULL,
    "generated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "suggestion_explanations_pkey" PRIMARY KEY ("id")
);

-- 同じ提案画面を再訪 / 別ユーザが同じ画面を開いても再課金しないための unique 制約
CREATE UNIQUE INDEX "uq_suggestion_explanation_target"
  ON "suggestion_explanations" ("project_id", "candidate_kind", "candidate_id");

-- テナント別の使用状況集計用 index (super_admin ダッシュボードで集計時に高速化)
CREATE INDEX "idx_suggestion_explanations_tenant"
  ON "suggestion_explanations" ("tenant_id", "generated_at" DESC);

-- 外部キー制約
ALTER TABLE "suggestion_explanations"
  ADD CONSTRAINT "suggestion_explanations_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "suggestion_explanations"
  ADD CONSTRAINT "suggestion_explanations_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects" ("id") ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "suggestion_explanations"
  ADD CONSTRAINT "suggestion_explanations_generated_by_fkey"
  FOREIGN KEY ("generated_by") REFERENCES "users" ("id") ON DELETE NO ACTION ON UPDATE CASCADE;
