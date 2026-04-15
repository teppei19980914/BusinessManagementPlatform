-- CreateTable
CREATE TABLE "retrospectives" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "project_id" UUID NOT NULL,
    "conducted_date" DATE NOT NULL,
    "plan_summary" TEXT NOT NULL,
    "actual_summary" TEXT NOT NULL,
    "good_points" TEXT NOT NULL,
    "problems" TEXT NOT NULL,
    "estimate_gap_factors" TEXT,
    "schedule_gap_factors" TEXT,
    "quality_issues" TEXT,
    "risk_response_evaluation" TEXT,
    "improvements" TEXT NOT NULL,
    "knowledge_to_share" TEXT,
    "state" VARCHAR(20) NOT NULL DEFAULT 'draft',
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "retrospectives_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "retrospective_comments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "retrospective_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "content" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "retrospective_comments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_retro_project" ON "retrospectives"("project_id");

-- AddForeignKey
ALTER TABLE "retrospectives" ADD CONSTRAINT "retrospectives_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "retrospective_comments" ADD CONSTRAINT "retrospective_comments_retrospective_id_fkey" FOREIGN KEY ("retrospective_id") REFERENCES "retrospectives"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
