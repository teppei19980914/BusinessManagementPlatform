/**
 * E2E DB ヘルパー (PR #92)
 *
 * 役割:
 *   Playwright プロセスから直接 Postgres にアクセスして、以下を行う:
 *   1. 初期 admin アカウントのシード (seed スクリプトと等価だが、idempotent に作り直せる)
 *   2. 実行後のデータクリーンアップ (RUN_ID 接頭辞に一致するユーザ/プロジェクトを削除)
 *
 * 設計判断 (生 SQL):
 *   Prisma 生成 client は `import.meta.url` を含む ESM で、Playwright の TypeScript
 *   ローダ (CJS デフォルト) から直接 import すると `exports is not defined in ES
 *   module scope` で落ちる (PR #92 の初回 CI で確認、DEVELOPER_GUIDE §9.7 に記載)。
 *   E2E の DB 操作は少数 (シード + クリーンアップのみ) なので pg の生 SQL で十分。
 *
 * 前提:
 *   - DATABASE_URL 環境変数が設定されていること (CI では e2e.yml で設定)
 */

import { Pool } from 'pg';
import { hash } from 'bcryptjs';
import { BCRYPT_COST } from '../../src/config/security';
import { DEFAULT_TENANT_ID } from '../../src/lib/tenant';

let _pool: Pool | null = null;

function getPool(): Pool {
  if (_pool) return _pool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL が未設定です。CI/ローカルで e2e 用 DB を設定してください。');
  }
  _pool = new Pool({ connectionString });
  return _pool;
}

export async function disconnectDb(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}

type AdminSeedOptions = {
  /**
   * Step 1 の「強制パスワード変更」フローをテストする場合は true。
   * 他機能の E2E では false にして初期設定を skip できる。既定 true。
   */
  forcePasswordChange?: boolean;
};

/**
 * 初期 admin を作成する (既存があれば状態をリセット)。
 * - forcePasswordChange: options.forcePasswordChange に従う (既定 true)
 * - mfaEnabled: false (Step 2 で有効化、PR #93 以降は skip 可能)
 * - isActive: true (seed と同じ)
 *
 * DELETE ではなく UPSERT にする理由:
 *   users からの FK は `ON DELETE RESTRICT` が大半 (audit_logs / project_members /
 *   recovery_codes / password_histories 等)。過去 run の関連レコードが残っていると
 *   DELETE で落ちる。UPSERT ならユーザ ID を固定したまま状態だけ初期化できる。
 */
export async function ensureInitialAdmin(
  email: string,
  password: string,
  options: AdminSeedOptions = {},
): Promise<string> {
  const forcePasswordChange = options.forcePasswordChange ?? true;
  const pool = getPool();
  const passwordHash = await hash(password, BCRYPT_COST);
  // updated_at は Prisma @updatedAt でアプリ側更新する契約 (DB デフォルト無し)。
  // ADR-0016 (2026-05-20): User.email を tenant-scoped 一意化したことに伴い、
  //   ON CONFLICT は (tenant_id, email) 複合 index = idx_users_tenant_email を参照する。
  // ★severity-1 (fix/tenant-id-default-removal, 2026-05-28, ADR-0024):
  //   旧仕様は schema DB DEFAULT に依存して tenant_id を省略していたが、ADR-0024 で
  //   DEFAULT を撤去したため fixture でも明示必須化。初期 admin は DEFAULT_TENANT に所属。
  const res = await pool.query(
    `INSERT INTO users (
       tenant_id, name, email, password_hash, system_role, is_active, force_password_change,
       mfa_enabled, mfa_secret_encrypted, mfa_enabled_at,
       failed_login_count, locked_until, permanent_lock,
       updated_at
     )
     VALUES ($1, $2, $3, $4, 'admin', true, $5, false, NULL, NULL, 0, NULL, false, NOW())
     ON CONFLICT (tenant_id, email) DO UPDATE SET
       password_hash = EXCLUDED.password_hash,
       is_active = true,
       force_password_change = EXCLUDED.force_password_change,
       mfa_enabled = false,
       mfa_secret_encrypted = NULL,
       mfa_enabled_at = NULL,
       failed_login_count = 0,
       locked_until = NULL,
       permanent_lock = false,
       updated_at = NOW()
     RETURNING id`,
    [DEFAULT_TENANT_ID, 'E2E 管理者', email, passwordHash, forcePasswordChange],
  );
  return res.rows[0].id as string;
}

/**
 * 一般ユーザ (general) を直接 DB に作成する。
 * 招待メール → setup-password フローを経由しないので、既存機能テストのセットアップに便利。
 */
export async function ensureGeneralUser(
  email: string,
  name: string,
  password: string,
): Promise<string> {
  const pool = getPool();
  const passwordHash = await hash(password, BCRYPT_COST);
  // ADR-0016 (2026-05-20): ON CONFLICT も (tenant_id, email) に変更
  // ★severity-1 (fix/tenant-id-default-removal, 2026-05-28, ADR-0024):
  //   ADR-0024 で schema DB DEFAULT 撤去。tenant_id を明示する必要あり。
  const res = await pool.query(
    // feat/account-status (2026-06-03): パスワード設定済み = 招待受諾済みの「有効」ユーザを表すため
    //   invitation_accepted_at を NOW() で設定する (NULL のままだと accountStatus='invited' = 招待中扱いになり、
    //   ユーザ編集ダイアログで削除ボタンが「招待取消」に切り替わる)。
    `INSERT INTO users (
       tenant_id, name, email, password_hash, system_role, is_active, force_password_change,
       mfa_enabled, mfa_secret_encrypted, mfa_enabled_at,
       failed_login_count, locked_until, permanent_lock,
       invitation_accepted_at, updated_at
     )
     VALUES ($1, $2, $3, $4, 'general', true, false, false, NULL, NULL, 0, NULL, false, NOW(), NOW())
     ON CONFLICT (tenant_id, email) DO UPDATE SET
       name = EXCLUDED.name,
       password_hash = EXCLUDED.password_hash,
       is_active = true,
       force_password_change = false,
       failed_login_count = 0,
       locked_until = NULL,
       permanent_lock = false,
       invitation_accepted_at = COALESCE(users.invitation_accepted_at, NOW()),
       updated_at = NOW()
     RETURNING id`,
    [DEFAULT_TENANT_ID, name, email, passwordHash],
  );
  return res.rows[0].id as string;
}

/**
 * 指定テナント (slug) 内の email に一致する user.id を取得する。
 *
 * 用途: signupTenantViaUi で払い出した admin を、その後プロジェクトメンバー (pm_tl) に
 *   追加するための userId 解決。プロジェクト作成者は自動メンバー化されない
 *   (createProject は ProjectMember を作らない) ため、プロジェクト配下の資産作成
 *   (knowledge/risk/retrospective) には明示的なメンバー追加が必要。
 *
 * email は tenant-scoped 一意 (ADR-0016) のため、同 email が複数テナントに存在し得る。
 * 必ず tenantSlug で絞り、目的のテナントの user を取得する。
 */
export async function getTenantUserIdByEmail(
  email: string,
  tenantSlug: string,
): Promise<string> {
  const pool = getPool();
  const res = await pool.query<{ id: string }>(
    `SELECT u.id
       FROM users u
       JOIN tenants t ON t.id = u.tenant_id
      WHERE u.email = $1 AND t.slug = $2
      LIMIT 1`,
    [email, tenantSlug],
  );
  if (res.rows.length === 0) {
    throw new Error(`getTenantUserIdByEmail: user not found (${email} @ ${tenantSlug})`);
  }
  return res.rows[0].id;
}

/**
 * 層2 (BEGINNER_REQUIRES_UPGRADE) 検証用の seed ヘルパ。
 *
 * ADR-0016 Revised の 3 層判定:
 *   - 層2 = 「email が users に存在するが、その user は created_by_user_id ではない (= 招待 / Default 所属)」
 *   → /signup で Beginner 不可・Expert/Pro のみ可。
 *
 * ensureGeneralUser は Default テナントに general user を作るため、その user は
 * いずれの tenant の created_by_user_id にもならない = まさに層2 の状態を満たす。
 * 本ヘルパは「層2 を作る」意図を明示するための薄いラッパ ([[feedback_reuse_existing_design_first]])。
 *
 * @returns 作成した user.id
 */
export async function seedLayer2MemberEmail(
  email: string,
  name: string,
  password: string,
): Promise<string> {
  // Default テナント所属の general user = created_by_user_id ではない → 層2
  return ensureGeneralUser(email, name, password);
}

/**
 * RUN_ID の形式を厳格に検証する。
 * 許可文字: 英数字 + ハイフン のみ (run-id.ts の RUN_ID 定義と一致)。
 * LIKE の wildcard (% / _) やクオート、セミコロン等が混入した時点で reject。
 * これにより `pattern = '%' + runId + '%'` でも意図しない行に一致しない。
 */
function assertRunIdFormat(runId: string): void {
  if (!/^[A-Za-z0-9-]{6,64}$/.test(runId)) {
    throw new Error(
      `cleanupByRunId: runId の形式が不正です (英数ハイフンのみ許可): ${JSON.stringify(runId)}`,
    );
  }
}

/**
 * RUN_ID 接頭辞に一致するテストデータを削除する (ベストエフォート)。
 * CI では Postgres コンテナ破棄で完全消去されるため、本処理は主にローカル実行時の
 * 残存防止用。
 *
 * 安全性:
 *   - runId は assertRunIdFormat で英数ハイフン限定に検証する (LIKE wildcard 汚染防止)
 *   - クエリは全て prepared statement ($1 / ANY($1))
 *
 * 注意:
 *   users からの多くの FK は `ON DELETE RESTRICT`。過去 run で audit_logs や
 *   recovery_codes が残っていると DELETE が失敗する。ここでは関連テーブルも
 *   明示的に削除する (順序依存)。FK 先同士は独立なので Promise.all で並列化。
 */
export async function cleanupByRunId(runId: string): Promise<void> {
  assertRunIdFormat(runId);

  const pool = getPool();
  const pattern = `%${runId}%`;

  // 1) 対象 ID を解決 (users / projects / customers は相互独立なので並列)
  const [userRes, projRes, custRes] = await Promise.all([
    pool.query<{ id: string }>(
      'SELECT id FROM users WHERE email LIKE $1 OR name LIKE $1',
      [pattern],
    ),
    pool.query<{ id: string }>('SELECT id FROM projects WHERE name LIKE $1', [pattern]),
    // PR #111-2: E2E fixture が自動作成する customer も掃除する
    pool.query<{ id: string }>('SELECT id FROM customers WHERE name LIKE $1', [pattern]),
  ]);
  const userIds = userRes.rows.map((r) => r.id);
  const projectIds = projRes.rows.map((r) => r.id);
  const customerIds = custRes.rows.map((r) => r.id);

  // 2) transaction で 2 段階削除 (FK 先 → 親)。クリーンアップは best-effort なので
  //    transaction 単位で失敗したらログだけ出して続行する。
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (userIds.length > 0 || projectIds.length > 0 || customerIds.length > 0) {
      // 2-a) RESTRICT FK 先を並列削除。全て独立な DELETE なので Promise.all で束ねる。
      const fkPromises: Promise<unknown>[] = [];
      if (userIds.length > 0) {
        fkPromises.push(
          client.query('DELETE FROM recovery_codes WHERE user_id = ANY($1)', [userIds]),
          client.query('DELETE FROM password_histories WHERE user_id = ANY($1)', [userIds]),
          client.query('DELETE FROM project_members WHERE user_id = ANY($1)', [userIds]),
          client.query('DELETE FROM audit_logs WHERE user_id = ANY($1)', [userIds]),
          client.query(
            'DELETE FROM role_change_logs WHERE changed_by = ANY($1) OR target_user_id = ANY($1)',
            [userIds],
          ),
          // SET NULL FK (auth_event_logs.user_id) は DELETE FROM users で勝手に NULL 化される
        );
      }
      if (projectIds.length > 0) {
        fkPromises.push(
          client.query('DELETE FROM project_members WHERE project_id = ANY($1)', [projectIds]),
        );
      }
      await Promise.all(fkPromises);

      // 2-b) 親テーブルを削除 (projects → customers → users の順)
      //   - projects は customer_id FK を持つが ON DELETE SET NULL なので順序不問
      //   - PR #111-2: customers は project 削除後に削除 (FK 警告を避ける)
      if (projectIds.length > 0) {
        await client.query('DELETE FROM projects WHERE id = ANY($1)', [projectIds]);
      }
      if (customerIds.length > 0) {
        await client.query('DELETE FROM customers WHERE id = ANY($1)', [customerIds]);
      }
      if (userIds.length > 0) {
        await client.query('DELETE FROM users WHERE id = ANY($1)', [userIds]);
      }
    }

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.warn('[e2e cleanup] 無視可能なエラー:', (e as Error).message);
  } finally {
    client.release();
  }
}

/**
 * RUN_ID prefix を含むテナント (= signupTenantViaUi が払い出したもの) を、配下の全業務データ +
 * 認証/課金/監査メタ + users もろとも **物理削除** する (test/release-acceptance-e2e で追加)。
 *
 * なぜ cleanupByRunId と別関数か:
 *   cleanupByRunId は users/projects/customers を RUN_ID で消すが **tenants 行は消さない**。
 *   さらに本サービスのセルフ解約 (deleteTenant) は abuse 防止のため users/tenant 行を
 *   **論理削除のまま永続保持** する (super-admin.service.ts purgeOldDeletedTenants 参照)。
 *   そのため signup ライフサイクル / セルフ解約 spec の後始末では、同 email が層1 (OWNED_TENANT_EXISTS)
 *   として残り続けるのを避けるべく、テナント本体まで物理 purge する必要がある。
 *
 * 安全性:
 *   - runId は assertRunIdFormat で英数ハイフン限定に検証 (LIKE wildcard 汚染防止)
 *   - 対象テナントは「name が RUN_ID を含む」または「created_by user の email が RUN_ID を含む」もの
 *   - FK 安全順 (子 → 親 → users → tenants) で削除。per-statement try/catch で best-effort
 *     (CI は ephemeral Postgres 破棄で完全消去されるため、本処理は主にローカル残存防止用)
 */
export async function cleanupTenantByRunId(runId: string): Promise<void> {
  assertRunIdFormat(runId);
  const pool = getPool();
  const pattern = `%${runId}%`;

  const tenantRes = await pool.query<{ id: string }>(
    `SELECT id FROM tenants
       WHERE name LIKE $1
          OR id IN (
            SELECT t.id FROM tenants t
              JOIN users u ON u.id = t.created_by_user_id
             WHERE u.email LIKE $1
          )`,
    [pattern],
  );
  const tenantIds = tenantRes.rows.map((r) => r.id);
  if (tenantIds.length === 0) return;

  // 子 → 親 → users → tenants の順。tenant_id を持たない子テーブルは親スコープ subquery で絞る。
  const statements: Array<{ label: string; sql: string }> = [
    { label: 'mentions', sql: 'DELETE FROM mentions WHERE tenant_id = ANY($1)' },
    { label: 'comments', sql: 'DELETE FROM comments WHERE tenant_id = ANY($1)' },
    { label: 'notifications', sql: 'DELETE FROM notifications WHERE tenant_id = ANY($1)' },
    { label: 'attachments', sql: 'DELETE FROM attachments WHERE tenant_id = ANY($1)' },
    {
      label: 'task_progress_logs',
      sql: 'DELETE FROM task_progress_logs WHERE task_id IN (SELECT t.id FROM tasks t JOIN projects p ON p.id = t.project_id WHERE p.tenant_id = ANY($1))',
    },
    {
      label: 'task_knowledges',
      sql: 'DELETE FROM task_knowledges WHERE knowledge_id IN (SELECT id FROM knowledges WHERE tenant_id = ANY($1))',
    },
    {
      label: 'knowledge_projects',
      sql: 'DELETE FROM knowledge_projects WHERE knowledge_id IN (SELECT id FROM knowledges WHERE tenant_id = ANY($1))',
    },
    {
      label: 'risk_issue_projects',
      sql: 'DELETE FROM risk_issue_projects WHERE risk_issue_id IN (SELECT id FROM risks_issues WHERE tenant_id = ANY($1))',
    },
    {
      label: 'retrospective_projects',
      sql: 'DELETE FROM retrospective_projects WHERE retrospective_id IN (SELECT id FROM retrospectives WHERE tenant_id = ANY($1))',
    },
    {
      label: 'tasks',
      sql: 'DELETE FROM tasks WHERE project_id IN (SELECT id FROM projects WHERE tenant_id = ANY($1))',
    },
    {
      label: 'estimates',
      sql: 'DELETE FROM estimates WHERE project_id IN (SELECT id FROM projects WHERE tenant_id = ANY($1))',
    },
    {
      label: 'project_members',
      sql: 'DELETE FROM project_members WHERE project_id IN (SELECT id FROM projects WHERE tenant_id = ANY($1))',
    },
    { label: 'suggestion_explanations', sql: 'DELETE FROM suggestion_explanations WHERE tenant_id = ANY($1)' },
    { label: 'risks_issues', sql: 'DELETE FROM risks_issues WHERE tenant_id = ANY($1)' },
    { label: 'retrospectives', sql: 'DELETE FROM retrospectives WHERE tenant_id = ANY($1)' },
    { label: 'stakeholders', sql: 'DELETE FROM stakeholders WHERE tenant_id = ANY($1)' },
    { label: 'knowledges', sql: 'DELETE FROM knowledges WHERE tenant_id = ANY($1)' },
    { label: 'memos', sql: 'DELETE FROM memos WHERE tenant_id = ANY($1)' },
    { label: 'projects', sql: 'DELETE FROM projects WHERE tenant_id = ANY($1)' },
    { label: 'customers', sql: 'DELETE FROM customers WHERE tenant_id = ANY($1)' },
    { label: 'tenant_import_preview', sql: 'DELETE FROM tenant_import_preview WHERE tenant_id = ANY($1)' },
    { label: 'api_call_logs', sql: 'DELETE FROM api_call_logs WHERE tenant_id = ANY($1)' },
    { label: 'tenant_monthly_usage_history', sql: 'DELETE FROM tenant_monthly_usage_history WHERE tenant_id = ANY($1)' },
    { label: 'billing_history', sql: 'DELETE FROM billing_history WHERE tenant_id = ANY($1)' },
    { label: 'stripe_usage_record_queue', sql: 'DELETE FROM stripe_usage_record_queue WHERE tenant_id = ANY($1)' },
    { label: 'tenant_consent_logs', sql: 'DELETE FROM tenant_consent_logs WHERE tenant_id = ANY($1)' },
    { label: 'audit_logs', sql: 'DELETE FROM audit_logs WHERE tenant_id = ANY($1)' },
    { label: 'role_change_logs', sql: 'DELETE FROM role_change_logs WHERE tenant_id = ANY($1)' },
    {
      label: 'sessions',
      sql: 'DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE tenant_id = ANY($1))',
    },
    { label: 'email_verification_tokens', sql: 'DELETE FROM email_verification_tokens WHERE tenant_id = ANY($1)' },
    { label: 'password_reset_tokens', sql: 'DELETE FROM password_reset_tokens WHERE tenant_id = ANY($1)' },
    { label: 'recovery_codes', sql: 'DELETE FROM recovery_codes WHERE tenant_id = ANY($1)' },
    { label: 'password_histories', sql: 'DELETE FROM password_histories WHERE tenant_id = ANY($1)' },
    { label: 'auth_event_logs', sql: 'DELETE FROM auth_event_logs WHERE tenant_id = ANY($1)' },
    { label: 'system_error_logs', sql: 'DELETE FROM system_error_logs WHERE tenant_id = ANY($1)' },
    { label: 'email_send_logs', sql: 'DELETE FROM email_send_logs WHERE tenant_id = ANY($1)' },
    { label: 'users', sql: 'DELETE FROM users WHERE tenant_id = ANY($1)' },
    { label: 'tenants', sql: 'DELETE FROM tenants WHERE id = ANY($1)' },
  ];

  for (const { label, sql } of statements) {
    try {
      await pool.query(sql, [tenantIds]);
    } catch (e) {
      // best-effort: 列名/テーブル差異やデータ不在は無視 (CI は DB 破棄で完全消去されるため)
      console.warn(`[e2e cleanupTenant] ${label} skip (無視可): ${(e as Error).message}`);
    }
  }
}
