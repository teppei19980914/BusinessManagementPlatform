-- ============================================================
-- ★severity-1 Tenant Isolation Fix (ADR-0024, 2026-05-28)
-- ============================================================
--
-- 背景:
--   schema.prisma の全 13 モデル (User / Customer / Project / RiskIssue /
--   Stakeholder / Knowledge / Retrospective / SystemErrorLog / Attachment /
--   Comment / Mention / Notification / Memo) に
--   `tenantId @default(dbgenerated("'00000000-0000-0000-0000-000000000001'::uuid"))`
--   が付いていた。これにより:
--
--     1. コードが tenantId を渡し忘れると **silent に Default テナント** に保存
--     2. テナント別一覧表示 (`where: { tenantId: viewerTenantId }`) で消える
--     3. システム管理者ダッシュボードの集計でも本来のテナントから消える
--     4. Default テナントには他テナントのデータが混入 (= 個人情報漏洩リスク)
--
--   実害バグ: src/services/risk.service.ts:460 createRisk と
--             src/services/retrospective.service.ts:304 createRetrospective が
--             tenantId を data に渡しておらず、すべての非 Default テナントの
--             RiskIssue / Retrospective が Default テナントに混入していた。
--
-- 対応:
--   1. 全 13 モデルの tenant_id カラムから DB DEFAULT を撤去
--   2. NOT NULL 制約は維持 (= コードが渡さないと Prisma が loud fail)
--   3. 既存データの修復は scripts/migrate-leaked-tenant-data.ts で別途実施
--
-- 参考:
--   - docs/adr/0024-explicit-tenant-id-no-db-default.md
--   - docs/knowledge/KDD_PATTERNS.md §"tenant_id DB DEFAULT silent fallthrough"
--   - docs/operations/INCIDENT_RESPONSE.md §2026-05-28 セキュリティインシデント
--
-- ロールバック手順 (緊急時のみ):
--   本 migration を revert したい場合、以下を順次実行する:
--
--   ALTER TABLE "users"             ALTER COLUMN "tenant_id" SET DEFAULT '00000000-0000-0000-0000-000000000001'::uuid;
--   ALTER TABLE "customers"         ALTER COLUMN "tenant_id" SET DEFAULT '00000000-0000-0000-0000-000000000001'::uuid;
--   ALTER TABLE "projects"          ALTER COLUMN "tenant_id" SET DEFAULT '00000000-0000-0000-0000-000000000001'::uuid;
--   ALTER TABLE "risks_issues"      ALTER COLUMN "tenant_id" SET DEFAULT '00000000-0000-0000-0000-000000000001'::uuid;
--   ALTER TABLE "stakeholders"      ALTER COLUMN "tenant_id" SET DEFAULT '00000000-0000-0000-0000-000000000001'::uuid;
--   ALTER TABLE "knowledges"        ALTER COLUMN "tenant_id" SET DEFAULT '00000000-0000-0000-0000-000000000001'::uuid;
--   ALTER TABLE "retrospectives"    ALTER COLUMN "tenant_id" SET DEFAULT '00000000-0000-0000-0000-000000000001'::uuid;
--   ALTER TABLE "system_error_logs" ALTER COLUMN "tenant_id" SET DEFAULT '00000000-0000-0000-0000-000000000001'::uuid;
--   ALTER TABLE "attachments"       ALTER COLUMN "tenant_id" SET DEFAULT '00000000-0000-0000-0000-000000000001'::uuid;
--   ALTER TABLE "comments"          ALTER COLUMN "tenant_id" SET DEFAULT '00000000-0000-0000-0000-000000000001'::uuid;
--   ALTER TABLE "mentions"          ALTER COLUMN "tenant_id" SET DEFAULT '00000000-0000-0000-0000-000000000001'::uuid;
--   ALTER TABLE "notifications"     ALTER COLUMN "tenant_id" SET DEFAULT '00000000-0000-0000-0000-000000000001'::uuid;
--   ALTER TABLE "memos"             ALTER COLUMN "tenant_id" SET DEFAULT '00000000-0000-0000-0000-000000000001'::uuid;
--
--   ロールバック実施時の注意:
--     - schema.prisma も同時に旧仕様 (`@default(dbgenerated(...))`) に戻す必要あり
--     - コード側で tenant_id を渡し忘れた create が再び silent fall-through する severity-1 リスクが復活
--     - 必ず ADR-0024 を Deprecated 化し、新たな ADR で復元理由を記録すること
-- ============================================================

ALTER TABLE "users"          ALTER COLUMN "tenant_id" DROP DEFAULT;
ALTER TABLE "customers"      ALTER COLUMN "tenant_id" DROP DEFAULT;
ALTER TABLE "projects"       ALTER COLUMN "tenant_id" DROP DEFAULT;
ALTER TABLE "risks_issues"   ALTER COLUMN "tenant_id" DROP DEFAULT;
ALTER TABLE "stakeholders"   ALTER COLUMN "tenant_id" DROP DEFAULT;
ALTER TABLE "knowledges"     ALTER COLUMN "tenant_id" DROP DEFAULT;
ALTER TABLE "retrospectives" ALTER COLUMN "tenant_id" DROP DEFAULT;
ALTER TABLE "system_error_logs" ALTER COLUMN "tenant_id" DROP DEFAULT;
ALTER TABLE "attachments"    ALTER COLUMN "tenant_id" DROP DEFAULT;
ALTER TABLE "comments"       ALTER COLUMN "tenant_id" DROP DEFAULT;
ALTER TABLE "mentions"       ALTER COLUMN "tenant_id" DROP DEFAULT;
ALTER TABLE "notifications"  ALTER COLUMN "tenant_id" DROP DEFAULT;
ALTER TABLE "memos"          ALTER COLUMN "tenant_id" DROP DEFAULT;
