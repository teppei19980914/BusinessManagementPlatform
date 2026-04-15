-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" VARCHAR(100) NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "password_hash" VARCHAR(255) NOT NULL,
    "system_role" VARCHAR(20) NOT NULL DEFAULT 'general',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "failed_login_count" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ,
    "permanent_lock" BOOLEAN NOT NULL DEFAULT false,
    "mfa_enabled" BOOLEAN NOT NULL DEFAULT false,
    "mfa_secret_encrypted" VARCHAR(255),
    "mfa_enabled_at" TIMESTAMPTZ,
    "last_login_at" TIMESTAMPTZ,
    "force_password_change" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "session_token" VARCHAR(255) NOT NULL,
    "user_id" UUID NOT NULL,
    "expires" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recovery_codes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "code_hash" VARCHAR(255) NOT NULL,
    "used_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recovery_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "password_histories" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "password_hash" VARCHAR(255) NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_histories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" VARCHAR(100) NOT NULL,
    "customer_name" VARCHAR(100) NOT NULL,
    "purpose" TEXT NOT NULL,
    "background" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "out_of_scope" TEXT,
    "dev_method" VARCHAR(30) NOT NULL,
    "business_domain_tags" JSONB NOT NULL DEFAULT '[]',
    "tech_stack_tags" JSONB NOT NULL DEFAULT '[]',
    "planned_start_date" DATE NOT NULL,
    "planned_end_date" DATE NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'planning',
    "notes" TEXT,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_members" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "project_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "project_role" VARCHAR(20) NOT NULL,
    "assigned_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "project_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tasks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "project_id" UUID NOT NULL,
    "parent_task_id" UUID,
    "wbs_number" VARCHAR(50),
    "name" VARCHAR(100) NOT NULL,
    "description" TEXT,
    "category" VARCHAR(30) NOT NULL,
    "assignee_id" UUID NOT NULL,
    "planned_start_date" DATE NOT NULL,
    "planned_end_date" DATE NOT NULL,
    "planned_effort" DECIMAL(10,2) NOT NULL,
    "priority" VARCHAR(10) DEFAULT 'medium',
    "status" VARCHAR(20) NOT NULL DEFAULT 'not_started',
    "progress_rate" INTEGER NOT NULL DEFAULT 0,
    "is_milestone" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_progress_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "task_id" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "update_date" DATE NOT NULL,
    "progress_rate" INTEGER NOT NULL,
    "actual_effort" DECIMAL(10,2) NOT NULL,
    "remaining_effort" DECIMAL(10,2),
    "status" VARCHAR(20) NOT NULL,
    "is_delayed" BOOLEAN NOT NULL DEFAULT false,
    "delay_reason" TEXT,
    "work_memo" TEXT,
    "has_issue" BOOLEAN NOT NULL DEFAULT false,
    "next_action" TEXT,
    "completed_date" DATE,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_progress_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "risks_issues" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "project_id" UUID NOT NULL,
    "type" VARCHAR(10) NOT NULL,
    "title" VARCHAR(100) NOT NULL,
    "content" TEXT NOT NULL,
    "cause" TEXT,
    "impact" VARCHAR(10) NOT NULL,
    "likelihood" VARCHAR(10),
    "priority" VARCHAR(10) NOT NULL,
    "response_policy" TEXT,
    "response_detail" TEXT,
    "reporter_id" UUID NOT NULL,
    "assignee_id" UUID,
    "deadline" DATE,
    "state" VARCHAR(20) NOT NULL DEFAULT 'open',
    "result" TEXT,
    "lesson_learned" TEXT,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "risks_issues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledges" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "title" VARCHAR(150) NOT NULL,
    "knowledge_type" VARCHAR(30) NOT NULL,
    "background" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "conclusion" TEXT,
    "recommendation" TEXT,
    "reusability" VARCHAR(10),
    "tech_tags" JSONB NOT NULL DEFAULT '[]',
    "dev_method" VARCHAR(30),
    "process_tags" JSONB NOT NULL DEFAULT '[]',
    "visibility" VARCHAR(20) NOT NULL DEFAULT 'draft',
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "knowledges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_projects" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "knowledge_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,

    CONSTRAINT "knowledge_projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_knowledges" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "task_id" UUID NOT NULL,
    "knowledge_id" UUID NOT NULL,

    CONSTRAINT "task_knowledges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "action" VARCHAR(50) NOT NULL,
    "entity_type" VARCHAR(50) NOT NULL,
    "entity_id" UUID NOT NULL,
    "before_value" JSONB,
    "after_value" JSONB,
    "ip_address" VARCHAR(45),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_event_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "event_type" VARCHAR(30) NOT NULL,
    "user_id" UUID,
    "email" VARCHAR(255),
    "ip_address" VARCHAR(45),
    "user_agent" TEXT,
    "detail" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_event_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_change_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "changed_by" UUID NOT NULL,
    "target_user_id" UUID NOT NULL,
    "change_type" VARCHAR(20) NOT NULL,
    "project_id" UUID,
    "before_role" VARCHAR(30),
    "after_role" VARCHAR(30) NOT NULL,
    "reason" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "role_change_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_users_active" ON "users"("is_active", "last_login_at");

-- CreateIndex
CREATE UNIQUE INDEX "idx_users_email" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_session_token_key" ON "sessions"("session_token");

-- CreateIndex
CREATE INDEX "idx_sessions_user" ON "sessions"("user_id");

-- CreateIndex
CREATE INDEX "idx_projects_status" ON "projects"("status");

-- CreateIndex
CREATE INDEX "idx_projects_customer" ON "projects"("customer_name");

-- CreateIndex
CREATE INDEX "idx_projects_dates" ON "projects"("planned_start_date", "planned_end_date");

-- CreateIndex
CREATE INDEX "idx_pm_project" ON "project_members"("project_id");

-- CreateIndex
CREATE INDEX "idx_pm_user" ON "project_members"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_pm_project_user" ON "project_members"("project_id", "user_id");

-- CreateIndex
CREATE INDEX "idx_tasks_project" ON "tasks"("project_id");

-- CreateIndex
CREATE INDEX "idx_tasks_assignee" ON "tasks"("assignee_id", "status");

-- CreateIndex
CREATE INDEX "idx_tasks_parent" ON "tasks"("parent_task_id");

-- CreateIndex
CREATE INDEX "idx_tasks_gantt" ON "tasks"("project_id", "planned_start_date", "planned_end_date");

-- CreateIndex
CREATE INDEX "idx_progress_task" ON "task_progress_logs"("task_id", "update_date" DESC);

-- CreateIndex
CREATE INDEX "idx_risks_project" ON "risks_issues"("project_id", "type");

-- CreateIndex
CREATE INDEX "idx_risks_state" ON "risks_issues"("state", "priority");

-- CreateIndex
CREATE INDEX "idx_risks_assignee" ON "risks_issues"("assignee_id");

-- CreateIndex
CREATE INDEX "idx_knowledges_type" ON "knowledges"("knowledge_type");

-- CreateIndex
CREATE INDEX "idx_knowledges_visibility" ON "knowledges"("visibility");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_projects_knowledge_id_project_id_key" ON "knowledge_projects"("knowledge_id", "project_id");

-- CreateIndex
CREATE UNIQUE INDEX "task_knowledges_task_id_knowledge_id_key" ON "task_knowledges"("task_id", "knowledge_id");

-- CreateIndex
CREATE INDEX "idx_audit_entity" ON "audit_logs"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "idx_audit_user" ON "audit_logs"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_audit_date" ON "audit_logs"("created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_auth_events_user" ON "auth_event_logs"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_auth_events_type" ON "auth_event_logs"("event_type", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recovery_codes" ADD CONSTRAINT "recovery_codes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "password_histories" ADD CONSTRAINT "password_histories_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_parent_task_id_fkey" FOREIGN KEY ("parent_task_id") REFERENCES "tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assignee_id_fkey" FOREIGN KEY ("assignee_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_progress_logs" ADD CONSTRAINT "task_progress_logs_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_progress_logs" ADD CONSTRAINT "task_progress_logs_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "risks_issues" ADD CONSTRAINT "risks_issues_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "risks_issues" ADD CONSTRAINT "risks_issues_reporter_id_fkey" FOREIGN KEY ("reporter_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "risks_issues" ADD CONSTRAINT "risks_issues_assignee_id_fkey" FOREIGN KEY ("assignee_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledges" ADD CONSTRAINT "knowledges_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledges" ADD CONSTRAINT "knowledges_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_projects" ADD CONSTRAINT "knowledge_projects_knowledge_id_fkey" FOREIGN KEY ("knowledge_id") REFERENCES "knowledges"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_projects" ADD CONSTRAINT "knowledge_projects_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_knowledges" ADD CONSTRAINT "task_knowledges_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_knowledges" ADD CONSTRAINT "task_knowledges_knowledge_id_fkey" FOREIGN KEY ("knowledge_id") REFERENCES "knowledges"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_event_logs" ADD CONSTRAINT "auth_event_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_change_logs" ADD CONSTRAINT "role_change_logs_changed_by_fkey" FOREIGN KEY ("changed_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_change_logs" ADD CONSTRAINT "role_change_logs_target_user_id_fkey" FOREIGN KEY ("target_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
