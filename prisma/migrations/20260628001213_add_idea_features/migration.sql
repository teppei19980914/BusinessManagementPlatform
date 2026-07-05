-- DropForeignKey
ALTER TABLE "api_call_logs" DROP CONSTRAINT "api_call_logs_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "api_call_logs" DROP CONSTRAINT "api_call_logs_user_id_fkey";

-- DropForeignKey
ALTER TABLE "asset_links" DROP CONSTRAINT "asset_links_created_by_fkey";

-- DropForeignKey
ALTER TABLE "asset_links" DROP CONSTRAINT "asset_links_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "attachments" DROP CONSTRAINT "attachments_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "audit_logs" DROP CONSTRAINT "audit_logs_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "auth_event_logs" DROP CONSTRAINT "auth_event_logs_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "billing_history" DROP CONSTRAINT "billing_history_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "comments" DROP CONSTRAINT "comments_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "comments" DROP CONSTRAINT "comments_user_id_fkey";

-- DropForeignKey
ALTER TABLE "customers" DROP CONSTRAINT "customers_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "email_verification_tokens" DROP CONSTRAINT "email_verification_tokens_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "issue_knowledge_promotions" DROP CONSTRAINT "issue_knowledge_promotions_created_by_fkey";

-- DropForeignKey
ALTER TABLE "issue_knowledge_promotions" DROP CONSTRAINT "issue_knowledge_promotions_issue_id_fkey";

-- DropForeignKey
ALTER TABLE "issue_knowledge_promotions" DROP CONSTRAINT "issue_knowledge_promotions_knowledge_id_fkey";

-- DropForeignKey
ALTER TABLE "knowledges" DROP CONSTRAINT "knowledges_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "memos" DROP CONSTRAINT "memos_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "mentions" DROP CONSTRAINT "mentions_target_user_id_fkey";

-- DropForeignKey
ALTER TABLE "mentions" DROP CONSTRAINT "mentions_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_user_id_fkey";

-- DropForeignKey
ALTER TABLE "password_histories" DROP CONSTRAINT "password_histories_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "password_reset_tokens" DROP CONSTRAINT "password_reset_tokens_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "projects" DROP CONSTRAINT "fk_projects_customer";

-- DropForeignKey
ALTER TABLE "projects" DROP CONSTRAINT "projects_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "recovery_codes" DROP CONSTRAINT "recovery_codes_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "retrospectives" DROP CONSTRAINT "retrospectives_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "risk_issue_promotions" DROP CONSTRAINT "risk_issue_promotions_created_by_fkey";

-- DropForeignKey
ALTER TABLE "risk_issue_promotions" DROP CONSTRAINT "risk_issue_promotions_issue_id_fkey";

-- DropForeignKey
ALTER TABLE "risk_issue_promotions" DROP CONSTRAINT "risk_issue_promotions_risk_id_fkey";

-- DropForeignKey
ALTER TABLE "risks_issues" DROP CONSTRAINT "risks_issues_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "role_change_logs" DROP CONSTRAINT "role_change_logs_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "stakeholders" DROP CONSTRAINT "stakeholders_project_id_fkey";

-- DropForeignKey
ALTER TABLE "stakeholders" DROP CONSTRAINT "stakeholders_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "stakeholders" DROP CONSTRAINT "stakeholders_user_id_fkey";

-- DropForeignKey
ALTER TABLE "stripe_usage_record_queue" DROP CONSTRAINT "stripe_usage_record_queue_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "suggestion_explanations" DROP CONSTRAINT "suggestion_explanations_generated_by_fkey";

-- DropForeignKey
ALTER TABLE "suggestion_explanations" DROP CONSTRAINT "suggestion_explanations_project_id_fkey";

-- DropForeignKey
ALTER TABLE "suggestion_explanations" DROP CONSTRAINT "suggestion_explanations_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "system_error_logs" DROP CONSTRAINT "fk_system_errors_user";

-- DropForeignKey
ALTER TABLE "system_error_logs" DROP CONSTRAINT "system_error_logs_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_assignee_id_fkey";

-- DropForeignKey
ALTER TABLE "tenant_consent_logs" DROP CONSTRAINT "tenant_consent_logs_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "tenant_import_preview" DROP CONSTRAINT "tenant_import_preview_created_by_user_id_fkey";

-- DropForeignKey
ALTER TABLE "tenant_import_preview" DROP CONSTRAINT "tenant_import_preview_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "tenant_monthly_usage_history" DROP CONSTRAINT "tenant_monthly_usage_history_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "users" DROP CONSTRAINT "users_tenant_id_fkey";

-- DropIndex
DROP INDEX "idx_knowledges_content_trgm";

-- DropIndex
DROP INDEX "idx_knowledges_title_trgm";

-- DropIndex
DROP INDEX "idx_retrospectives_improvements_trgm";

-- DropIndex
DROP INDEX "idx_retrospectives_problems_trgm";

-- DropIndex
DROP INDEX "idx_risks_issues_content_trgm";

-- DropIndex
DROP INDEX "idx_risks_issues_title_trgm";

-- AlterTable
ALTER TABLE "billing_history" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "comments" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "customers" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "faq_embeddings" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "guide_embeddings" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "stakeholders" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "tenants" ALTER COLUMN "updated_at" DROP DEFAULT,
ALTER COLUMN "tenant_seq" DROP DEFAULT;
DROP SEQUENCE "tenants_tenant_seq_seq";

-- CreateTable
CREATE TABLE "idea_voting_sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "kind" VARCHAR(10) NOT NULL,
    "vote_type" VARCHAR(10) NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "description" TEXT,
    "votes_per_member" INTEGER,
    "status" VARCHAR(10) NOT NULL DEFAULT 'active',
    "ends_at" TIMESTAMPTZ NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "closed_by" UUID,
    "closed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "idea_voting_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idea_voting_options" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "session_id" UUID NOT NULL,
    "label" VARCHAR(200) NOT NULL,
    "display_order" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idea_voting_options_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idea_voting_submissions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "session_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "submitted_by" UUID NOT NULL,
    "reason" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "idea_voting_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idea_voting_allocations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "submission_id" UUID NOT NULL,
    "option_id" UUID NOT NULL,
    "votes" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "idea_voting_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idea_whiteboard_sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "description" TEXT,
    "status" VARCHAR(10) NOT NULL DEFAULT 'active',
    "ends_at" TIMESTAMPTZ NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "closed_by" UUID,
    "closed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "idea_whiteboard_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idea_whiteboard_notes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "session_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "submitted_by" UUID NOT NULL,
    "content" TEXT NOT NULL,
    "category" VARCHAR(50),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "idea_whiteboard_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idea_qa_threads" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "question" TEXT NOT NULL,
    "submitted_by" UUID NOT NULL,
    "answer_count" INTEGER NOT NULL DEFAULT 0,
    "last_answered_at" TIMESTAMPTZ,
    "upvote_count" INTEGER NOT NULL DEFAULT 0,
    "status" VARCHAR(10) NOT NULL DEFAULT 'open',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "idea_qa_threads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idea_qa_answers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "thread_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "submitted_by" UUID NOT NULL,
    "content" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "idea_qa_answers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idea_qa_upvotes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "thread_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idea_qa_upvotes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idea_asset_links" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "source_type" VARCHAR(30) NOT NULL,
    "source_id" UUID NOT NULL,
    "target_type" VARCHAR(20) NOT NULL,
    "target_id" UUID NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idea_asset_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_idea_voting_sessions_project" ON "idea_voting_sessions"("tenant_id", "project_id");

-- CreateIndex
CREATE INDEX "idx_idea_voting_sessions_kind_status" ON "idea_voting_sessions"("tenant_id", "project_id", "kind", "status");

-- CreateIndex
CREATE INDEX "idx_idea_voting_sessions_status_ends" ON "idea_voting_sessions"("tenant_id", "status", "ends_at");

-- CreateIndex
CREATE INDEX "idx_idea_voting_options_session" ON "idea_voting_options"("session_id");

-- CreateIndex
CREATE INDEX "idx_idea_voting_submissions_session" ON "idea_voting_submissions"("session_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_idea_voting_submission_per_user" ON "idea_voting_submissions"("session_id", "submitted_by");

-- CreateIndex
CREATE INDEX "idx_idea_voting_allocations_submission" ON "idea_voting_allocations"("submission_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_idea_voting_allocation_per_option" ON "idea_voting_allocations"("submission_id", "option_id");

-- CreateIndex
CREATE INDEX "idx_idea_whiteboard_sessions_project" ON "idea_whiteboard_sessions"("tenant_id", "project_id");

-- CreateIndex
CREATE INDEX "idx_idea_whiteboard_sessions_status" ON "idea_whiteboard_sessions"("tenant_id", "project_id", "status");

-- CreateIndex
CREATE INDEX "idx_idea_whiteboard_sessions_ends" ON "idea_whiteboard_sessions"("tenant_id", "status", "ends_at");

-- CreateIndex
CREATE INDEX "idx_idea_whiteboard_notes_session" ON "idea_whiteboard_notes"("session_id");

-- CreateIndex
CREATE INDEX "idx_idea_whiteboard_notes_session_user" ON "idea_whiteboard_notes"("session_id", "submitted_by");

-- CreateIndex
CREATE INDEX "idx_idea_qa_threads_project" ON "idea_qa_threads"("tenant_id", "project_id");

-- CreateIndex
CREATE INDEX "idx_idea_qa_threads_status" ON "idea_qa_threads"("tenant_id", "project_id", "status");

-- CreateIndex
CREATE INDEX "idx_idea_qa_threads_created" ON "idea_qa_threads"("tenant_id", "project_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_idea_qa_answers_thread" ON "idea_qa_answers"("thread_id");

-- CreateIndex
CREATE INDEX "idx_idea_qa_upvotes_thread" ON "idea_qa_upvotes"("thread_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_idea_qa_upvote_per_user" ON "idea_qa_upvotes"("thread_id", "user_id");

-- CreateIndex
CREATE INDEX "idx_idea_asset_links_source" ON "idea_asset_links"("tenant_id", "source_type", "source_id");

-- CreateIndex
CREATE INDEX "idx_idea_asset_links_target" ON "idea_asset_links"("tenant_id", "target_type", "target_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_idea_asset_link" ON "idea_asset_links"("source_type", "source_id", "target_type", "target_id");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_verification_tokens" ADD CONSTRAINT "email_verification_tokens_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recovery_codes" ADD CONSTRAINT "recovery_codes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "password_histories" ADD CONSTRAINT "password_histories_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assignee_id_fkey" FOREIGN KEY ("assignee_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "risks_issues" ADD CONSTRAINT "risks_issues_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stakeholders" ADD CONSTRAINT "stakeholders_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stakeholders" ADD CONSTRAINT "stakeholders_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stakeholders" ADD CONSTRAINT "stakeholders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledges" ADD CONSTRAINT "knowledges_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "retrospectives" ADD CONSTRAINT "retrospectives_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_event_logs" ADD CONSTRAINT "auth_event_logs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "system_error_logs" ADD CONSTRAINT "system_error_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "system_error_logs" ADD CONSTRAINT "system_error_logs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_change_logs" ADD CONSTRAINT "role_change_logs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mentions" ADD CONSTRAINT "mentions_target_user_id_fkey" FOREIGN KEY ("target_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mentions" ADD CONSTRAINT "mentions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memos" ADD CONSTRAINT "memos_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "risk_issue_promotions" ADD CONSTRAINT "risk_issue_promotions_risk_id_fkey" FOREIGN KEY ("risk_id") REFERENCES "risks_issues"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "risk_issue_promotions" ADD CONSTRAINT "risk_issue_promotions_issue_id_fkey" FOREIGN KEY ("issue_id") REFERENCES "risks_issues"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "risk_issue_promotions" ADD CONSTRAINT "risk_issue_promotions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "issue_knowledge_promotions" ADD CONSTRAINT "issue_knowledge_promotions_issue_id_fkey" FOREIGN KEY ("issue_id") REFERENCES "risks_issues"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "issue_knowledge_promotions" ADD CONSTRAINT "issue_knowledge_promotions_knowledge_id_fkey" FOREIGN KEY ("knowledge_id") REFERENCES "knowledges"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "issue_knowledge_promotions" ADD CONSTRAINT "issue_knowledge_promotions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_links" ADD CONSTRAINT "asset_links_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_links" ADD CONSTRAINT "asset_links_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_call_logs" ADD CONSTRAINT "api_call_logs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_call_logs" ADD CONSTRAINT "api_call_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "suggestion_explanations" ADD CONSTRAINT "suggestion_explanations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "suggestion_explanations" ADD CONSTRAINT "suggestion_explanations_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "suggestion_explanations" ADD CONSTRAINT "suggestion_explanations_generated_by_fkey" FOREIGN KEY ("generated_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_monthly_usage_history" ADD CONSTRAINT "tenant_monthly_usage_history_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_import_preview" ADD CONSTRAINT "tenant_import_preview_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_import_preview" ADD CONSTRAINT "tenant_import_preview_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_history" ADD CONSTRAINT "billing_history_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stripe_usage_record_queue" ADD CONSTRAINT "stripe_usage_record_queue_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_consent_logs" ADD CONSTRAINT "tenant_consent_logs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idea_voting_sessions" ADD CONSTRAINT "idea_voting_sessions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idea_voting_sessions" ADD CONSTRAINT "idea_voting_sessions_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idea_voting_sessions" ADD CONSTRAINT "idea_voting_sessions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idea_voting_options" ADD CONSTRAINT "idea_voting_options_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "idea_voting_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idea_voting_submissions" ADD CONSTRAINT "idea_voting_submissions_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "idea_voting_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idea_voting_allocations" ADD CONSTRAINT "idea_voting_allocations_submission_id_fkey" FOREIGN KEY ("submission_id") REFERENCES "idea_voting_submissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idea_voting_allocations" ADD CONSTRAINT "idea_voting_allocations_option_id_fkey" FOREIGN KEY ("option_id") REFERENCES "idea_voting_options"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idea_whiteboard_sessions" ADD CONSTRAINT "idea_whiteboard_sessions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idea_whiteboard_sessions" ADD CONSTRAINT "idea_whiteboard_sessions_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idea_whiteboard_sessions" ADD CONSTRAINT "idea_whiteboard_sessions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idea_whiteboard_notes" ADD CONSTRAINT "idea_whiteboard_notes_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "idea_whiteboard_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idea_qa_threads" ADD CONSTRAINT "idea_qa_threads_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idea_qa_threads" ADD CONSTRAINT "idea_qa_threads_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idea_qa_answers" ADD CONSTRAINT "idea_qa_answers_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "idea_qa_threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idea_qa_upvotes" ADD CONSTRAINT "idea_qa_upvotes_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "idea_qa_threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idea_asset_links" ADD CONSTRAINT "idea_asset_links_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idea_asset_links" ADD CONSTRAINT "idea_asset_links_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "retrospective_projects_retro_project_unique" RENAME TO "retrospective_projects_retrospective_id_project_id_key";

-- RenameIndex
ALTER INDEX "risk_issue_projects_risk_issue_project_unique" RENAME TO "risk_issue_projects_risk_issue_id_project_id_key";

-- RenameIndex
ALTER INDEX "tenant_consent_logs_unique_per_version" RENAME TO "tenant_consent_logs_tenant_id_consent_type_version_key";
