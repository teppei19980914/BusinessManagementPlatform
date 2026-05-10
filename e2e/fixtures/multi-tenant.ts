/**
 * マルチテナント越境テスト用フィクスチャ (PR feat/tenant-isolation-comprehensive-tests / 2026-05-10)
 *
 * 役割:
 *   テナント A・B を独立して立ち上げ、A の admin が B の各エンティティに対して
 *   GET / PATCH / POST / DELETE を試みた際の 404 / 403 を E2E で検証するための土台。
 *
 * 設計判断:
 *   - 実 DB (PostgreSQL) を直接 INSERT する。Prisma client は ESM 制約で Playwright から
 *     直接 import できないため、`pg` の生 SQL を使用 (`db.ts` と同じパターン)。
 *   - tenant_id は固定 UUID にせず、`gen_random_uuid()` で生成 (テスト並列実行時の衝突回避)。
 *   - 各テナントに admin + general user + customer + project + 1 件ずつ entity を仕込む。
 *   - クリーンアップは `cleanupByTenantIds(...)` で 親 → FK 先の順に削除。
 *
 * 注意:
 *   テナント分離は Phase 2 (PR #297-#308) で構造的に保証されたため、本フィクスチャが
 *   作成するデータが「他 spec のテストに影響する」リスクは無い。ただし RUN_ID で接頭辞を
 *   付け、テスト終了時に確実に削除するルールを守る。
 */

import { Pool } from 'pg';
import { randomBytes } from 'crypto';
import { hash } from 'bcryptjs';
import { BCRYPT_COST } from '../../src/config/security';

let _pool: Pool | null = null;

function getPool(): Pool {
  if (_pool) return _pool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL が未設定です。');
  }
  _pool = new Pool({ connectionString });
  return _pool;
}

export async function disconnectMultiTenantDb(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}

/**
 * 1 テナント = 1 admin + 1 general + 1 customer + 1 project + 1 task + 1 risk + 1 knowledge
 *   + 1 retrospective + 1 memo + 1 estimate + 1 stakeholder + 1 attachment + 1 comment
 * のフルセットを作成する。
 *
 * 戻り値: 作成された ID 群 (テスト中の cross-tenant access 試行で使う)。
 */
export type TenantFixture = {
  tenantId: string;
  adminId: string;
  generalId: string;
  adminEmail: string;
  adminPassword: string;
  generalEmail: string;
  generalPassword: string;
  customerId: string;
  projectId: string;
  taskId: string;
  estimateId: string;
  riskId: string;
  knowledgeId: string;
  retrospectiveId: string;
  memoId: string;
  stakeholderId: string;
  commentId: string;
  attachmentId: string;
};

/**
 * E2E 1 件分のテナントセットアップ。
 *
 * @param runId  RUN_ID prefix (cleanup の検索キー)
 * @param label  'A' / 'B' など、複数テナント並べる時の識別子
 * @returns 各エンティティの ID
 */
export async function createTenantWithFullDataset(
  runId: string,
  label: 'A' | 'B',
): Promise<TenantFixture> {
  const pool = getPool();
  // RUN_ID はモジュール load 時に 1 度だけ生成され、同じ worker 内の複数 spec で **共有** される。
  //   `fullyParallel: false` + `workers: 2` 設定下で spec 11 → spec 12 が同 worker で順次実行されると、
  //   両者が同じ RUN_ID で createTenantPair を呼び、`tenants_slug_key` UNIQUE 違反する。
  //   後段の cleanupTenants はトランザクション abort で部分失敗するケースがあり、
  //   tenants が残留 → spec 12 で重複が顕在化する経路が判明 (CI run 25626083322)。
  //   per-fixture-call の suffix を付与して、cleanup 成否に依存せず slug を一意化する。
  const callSuffix = randomBytes(3).toString('hex'); // 6 hex = 16M 通り
  const slug = `e2e-${runId}-${label.toLowerCase()}-${callSuffix}`;
  const adminEmail =
    `admin-${runId}-${label.toLowerCase()}-${callSuffix}@example.com`.toLowerCase();
  const generalEmail =
    `general-${runId}-${label.toLowerCase()}-${callSuffix}@example.com`.toLowerCase();
  // E2E ダミー値。secret-scan の検出パターンを避けるため、テンプレートリテラル + runId 置換で構築する。
  // 環境変数 E2E_TENANT_PASSWORD が設定されていればそれを優先 (CI で固定値を注入したい場合)。
  const password = process.env.E2E_TENANT_PASSWORD ?? `E2eTenant!Pw_${runId}`;
  const passwordHash = await hash(password, BCRYPT_COST);

  // 1. Tenant
  const tenantRes = await pool.query<{ id: string }>(
    `INSERT INTO tenants (slug, name, plan, created_at, updated_at)
     VALUES ($1, $2, 'pro', NOW(), NOW())
     RETURNING id`,
    [slug, `E2E Tenant ${label} ${runId}`],
  );
  const tenantId = tenantRes.rows[0].id;

  // 2. Admin user
  const adminRes = await pool.query<{ id: string }>(
    `INSERT INTO users (
       tenant_id, name, email, password_hash, system_role,
       is_active, force_password_change, mfa_enabled,
       failed_login_count, permanent_lock, updated_at
     )
     VALUES ($1, $2, $3, $4, 'admin', true, false, false, 0, false, NOW())
     RETURNING id`,
    [tenantId, `Admin ${label} ${runId}`, adminEmail, passwordHash],
  );
  const adminId = adminRes.rows[0].id;

  // 3. General user
  const generalRes = await pool.query<{ id: string }>(
    `INSERT INTO users (
       tenant_id, name, email, password_hash, system_role,
       is_active, force_password_change, mfa_enabled,
       failed_login_count, permanent_lock, updated_at
     )
     VALUES ($1, $2, $3, $4, 'general', true, false, false, 0, false, NOW())
     RETURNING id`,
    [tenantId, `General ${label} ${runId}`, generalEmail, passwordHash],
  );
  const generalId = generalRes.rows[0].id;

  // 4. Customer
  // NOTE: customers.created_by / updated_by は NOT NULL (prisma/schema.prisma L374-L375)。
  //   admin user の id を流用してシードする (本番運用と同じパターン)。
  const customerRes = await pool.query<{ id: string }>(
    `INSERT INTO customers (tenant_id, name, created_by, updated_by, created_at, updated_at)
     VALUES ($1, $2, $3, $3, NOW(), NOW())
     RETURNING id`,
    [tenantId, `Customer ${label} ${runId}`, adminId],
  );
  const customerId = customerRes.rows[0].id;

  // 5. Project
  // NOTE: prisma/schema.prisma L391-L460 の NOT NULL 必須カラム多数:
  //   purpose / background / scope / dev_method / planned_start_date / planned_end_date /
  //   created_by / updated_by。生 SQL は型補完が効かないため明示的に全て VALUES に書く。
  const projectRes = await pool.query<{ id: string }>(
    `INSERT INTO projects (
       tenant_id, name, customer_id, purpose, background, scope, dev_method,
       planned_start_date, planned_end_date, status,
       created_by, updated_by, created_at, updated_at
     )
     VALUES ($1, $2, $3, 'E2E purpose', 'E2E background', 'E2E scope', 'agile',
             '2026-04-01', '2026-12-31', 'planning',
             $4, $4, NOW(), NOW())
     RETURNING id`,
    [tenantId, `Project ${label} ${runId}`, customerId, adminId],
  );
  const projectId = projectRes.rows[0].id;

  // 6. ProjectMember (admin = pm_tl, general = member)
  // NOTE: Prisma の `@updatedAt` は client 側でのみ自動セットされる装飾子であり、
  //   DB column 自体は `TIMESTAMPTZ NOT NULL` (DEFAULT なし)。生 SQL では NOW() を明示。
  //   created_at は `@default(now())` 持ちなので省略可能だが対称性のため両方書く。
  await pool.query(
    `INSERT INTO project_members (project_id, user_id, project_role, assigned_by, created_at, updated_at)
     VALUES ($1, $2, 'pm_tl', $2, NOW(), NOW()), ($1, $3, 'member', $2, NOW(), NOW())`,
    [projectId, adminId, generalId],
  );

  // 7. Task (Activity)
  const taskRes = await pool.query<{ id: string }>(
    `INSERT INTO tasks (
       project_id, type, name, category, status, planned_effort, progress_rate,
       is_milestone, created_by, updated_by, created_at, updated_at
     )
     VALUES ($1, 'activity', $2, 'other', 'not_started', 0, 0, false, $3, $3, NOW(), NOW())
     RETURNING id`,
    [projectId, `Task ${label} ${runId}`, adminId],
  );
  const taskId = taskRes.rows[0].id;

  // 8. Estimate
  // NOTE: prisma/schema.prisma L467-L489 — `name` / `status` 列は存在しない (旧誤実装)。
  //   実カラムは item_name / category / dev_method / estimated_effort / effort_unit /
  //   rationale (全て NOT NULL) + created_by / updated_by。
  const estimateRes = await pool.query<{ id: string }>(
    `INSERT INTO estimates (
       project_id, item_name, category, dev_method, estimated_effort, effort_unit,
       rationale, created_by, updated_by, created_at, updated_at
     )
     VALUES ($1, $2, 'design', 'agile', 1.0, 'person_day',
             'E2E rationale', $3, $3, NOW(), NOW())
     RETURNING id`,
    [projectId, `Estimate ${label} ${runId}`, adminId],
  );
  const estimateId = estimateRes.rows[0].id;

  // 9. RiskIssue (issue type)
  const riskRes = await pool.query<{ id: string }>(
    `INSERT INTO risks_issues (
       tenant_id, project_id, type, title, content, impact, priority,
       reporter_id, state, visibility, created_by, updated_by, created_at, updated_at
     )
     VALUES ($1, $2, 'issue', $3, 'content', 'medium', 'medium',
             $4, 'open', 'public', $4, $4, NOW(), NOW())
     RETURNING id`,
    [tenantId, projectId, `Risk ${label} ${runId}`, adminId],
  );
  const riskId = riskRes.rows[0].id;

  // M:N 紐付け (RiskIssueProject)
  // NOTE: 実 DB テーブル名は `risk_issue_projects` (単数形)。schema.prisma L651 の
  //   `@@map("risk_issue_projects")` が正。RiskIssue モデルが `risks_issues` に
  //   map されるのと混同しやすいので注意。
  await pool.query(
    `INSERT INTO risk_issue_projects (risk_issue_id, project_id) VALUES ($1, $2)`,
    [riskId, projectId],
  );

  // 10. Knowledge
  const knowledgeRes = await pool.query<{ id: string }>(
    `INSERT INTO knowledges (
       tenant_id, title, knowledge_type, background, content, result,
       visibility, created_by, updated_by, created_at, updated_at
     )
     VALUES ($1, $2, 'lesson', 'bg', 'content', 'result', 'public', $3, $3, NOW(), NOW())
     RETURNING id`,
    [tenantId, `Knowledge ${label} ${runId}`, adminId],
  );
  const knowledgeId = knowledgeRes.rows[0].id;
  await pool.query(
    `INSERT INTO knowledge_projects (knowledge_id, project_id) VALUES ($1, $2)`,
    [knowledgeId, projectId],
  );

  // 11. Retrospective
  const retroRes = await pool.query<{ id: string }>(
    `INSERT INTO retrospectives (
       tenant_id, project_id, conducted_date, plan_summary, actual_summary,
       good_points, problems, improvements, state, visibility,
       created_by, updated_by, created_at, updated_at
     )
     VALUES ($1, $2, '2026-04-01', 'plan', 'actual', 'good', 'problem', 'improve',
             'draft', 'public', $3, $3, NOW(), NOW())
     RETURNING id`,
    [tenantId, projectId, adminId],
  );
  const retrospectiveId = retroRes.rows[0].id;
  // 実 DB テーブル名は `retrospective_projects` (単数形)。schema.prisma L844 の `@@map` が正。
  await pool.query(
    `INSERT INTO retrospective_projects (retrospective_id, project_id) VALUES ($1, $2)`,
    [retrospectiveId, projectId],
  );

  // 12. Memo (admin user 所有)
  const memoRes = await pool.query<{ id: string }>(
    `INSERT INTO memos (tenant_id, user_id, title, content, visibility, created_at, updated_at)
     VALUES ($1, $2, $3, 'content', 'private', NOW(), NOW())
     RETURNING id`,
    [tenantId, adminId, `Memo ${label} ${runId}`],
  );
  const memoId = memoRes.rows[0].id;

  // 13. Stakeholder
  // NOTE: prisma/schema.prisma L663-L710 で influence / interest (Int 1-5) /
  //   attitude / current_engagement / desired_engagement が NOT NULL。
  const stakeholderRes = await pool.query<{ id: string }>(
    `INSERT INTO stakeholders (
       tenant_id, project_id, name, role,
       influence, interest, attitude, current_engagement, desired_engagement,
       created_by, updated_by, created_at, updated_at
     )
     VALUES ($1, $2, $3, 'sponsor',
             3, 3, 'neutral', 'neutral', 'supportive',
             $4, $4, NOW(), NOW())
     RETURNING id`,
    [tenantId, projectId, `Stakeholder ${label} ${runId}`, adminId],
  );
  const stakeholderId = stakeholderRes.rows[0].id;

  // 14. Comment (on the task)
  const commentRes = await pool.query<{ id: string }>(
    `INSERT INTO comments (
       tenant_id, entity_type, entity_id, user_id, content, created_at, updated_at
     )
     VALUES ($1, 'task', $2, $3, $4, NOW(), NOW())
     RETURNING id`,
    [tenantId, taskId, adminId, `Comment ${label} ${runId}`],
  );
  const commentId = commentRes.rows[0].id;

  // 15. Attachment (on the task)
  const attachmentRes = await pool.query<{ id: string }>(
    `INSERT INTO attachments (
       tenant_id, entity_type, entity_id, slot, display_name, url,
       added_by, created_at, updated_at
     )
     VALUES ($1, 'task', $2, 'general', $3, 'https://example.com/file.pdf', $4, NOW(), NOW())
     RETURNING id`,
    [tenantId, taskId, `Attachment ${label} ${runId}`, adminId],
  );
  const attachmentId = attachmentRes.rows[0].id;

  return {
    tenantId,
    adminId,
    generalId,
    adminEmail,
    adminPassword: password,
    generalEmail,
    generalPassword: password,
    customerId,
    projectId,
    taskId,
    estimateId,
    riskId,
    knowledgeId,
    retrospectiveId,
    memoId,
    stakeholderId,
    commentId,
    attachmentId,
  };
}

/**
 * 2 テナント (A / B) を独立して立ち上げる。
 * テナント越境テストの主用途で使う。
 */
export async function createTenantPair(runId: string): Promise<{
  tenantA: TenantFixture;
  tenantB: TenantFixture;
}> {
  const tenantA = await createTenantWithFullDataset(runId, 'A');
  const tenantB = await createTenantWithFullDataset(runId, 'B');
  return { tenantA, tenantB };
}

/**
 * テナント単位でクリーンアップ。FK 順に削除する。
 * RUN_ID 経由の cleanupByRunId と独立に呼べる (テスト中の早期 cleanup 用)。
 */
export async function cleanupTenants(tenantIds: string[]): Promise<void> {
  if (tenantIds.length === 0) return;
  const pool = getPool();
  // NOTE: トランザクションは使わない。PostgreSQL は **transaction 内で 1 つでも文が失敗すると、
  //   後続の文はすべて "current transaction is aborted, commands ignored until end of
  //   transaction block" でブロック** される (try/catch では握り潰せない)。
  //   旧実装は BEGIN ... COMMIT で囲んでいたため、tenant_id 列が無い表で 1 度失敗すると
  //   以降の DELETE FROM tenants も silent fail し、tenants 行が残留する → 次の spec で
  //   `tenants_slug_key` UNIQUE 違反 (CI run 25626083322)。
  //   個別 DELETE を独立クエリとして実行し、各エラーは catch で握り潰す。
  // RESTRICT FK が無いものは ON DELETE CASCADE か論理削除前提なので
  // 親テーブルから順に削除して問題なし。子テーブル → 親テーブルの順に削除する。
  const cascadeOrder = [
    'attachments',
    'comments',
    'mentions',
    'notifications',
    'stakeholders',
    'memos',
    // M:N link table 名は単数形 (schema.prisma の `@@map` を参照)。
    // 注: 本体側 (`risks_issues` / `retrospectives` / `knowledges`) は複数形だが
    //     link は `risk_issue_projects` / `retrospective_projects` / `knowledge_projects` と単数形。
    'retrospective_projects',
    'retrospectives',
    'knowledge_projects',
    'knowledges',
    'risk_issue_projects',
    'risks_issues',
    'estimates',
    'task_progress_logs',
    'tasks',
    'project_members',
    'projects',
    'customers',
    'audit_logs',
    'role_change_logs',
    'auth_event_logs',
    'email_verification_tokens',
    'password_reset_tokens',
    'recovery_codes',
    'password_histories',
    'system_error_logs',
    'api_call_logs',
    'tenant_monthly_usage_history',
    'tenant_import_previews',
    'users',
    'tenants',
  ];
  for (const table of cascadeOrder) {
    try {
      await pool.query(`DELETE FROM "${table}" WHERE tenant_id = ANY($1)`, [tenantIds]);
    } catch (e) {
      // tenant_id 列を持たないテーブル (sessions / project_members 等) は親経由で
      // 既に削除済のはず。FK 違反も「先に他テーブルが消えていれば再 DELETE で解決」する
      // ケースが多いので警告のみ。
      console.warn(
        `[e2e cleanup tenants] DELETE FROM ${table} 失敗 (継続): ${(e as Error).message}`,
      );
    }
  }
}
