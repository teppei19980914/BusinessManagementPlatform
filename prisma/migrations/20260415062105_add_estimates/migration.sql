-- CreateTable
CREATE TABLE "estimates" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "project_id" UUID NOT NULL,
    "item_name" VARCHAR(100) NOT NULL,
    "category" VARCHAR(30) NOT NULL,
    "dev_method" VARCHAR(30) NOT NULL,
    "estimated_effort" DECIMAL(10,2) NOT NULL,
    "effort_unit" VARCHAR(20) NOT NULL,
    "rationale" TEXT NOT NULL,
    "preconditions" TEXT,
    "is_confirmed" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "estimates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_estimates_project" ON "estimates"("project_id");

-- AddForeignKey
ALTER TABLE "estimates" ADD CONSTRAINT "estimates_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
