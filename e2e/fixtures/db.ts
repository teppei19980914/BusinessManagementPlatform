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

export async function disconnectPrisma(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}

/**
 * 初期 admin を作成する (既存があれば状態をリセット)。
 * - forcePasswordChange: true (Step 1 で変更を要求)
 * - mfaEnabled: false (Step 2 で有効化)
 * - isActive: true (seed と同じ)
 *
 * DELETE ではなく UPSERT にする理由:
 *   users からの FK は `ON DELETE RESTRICT` が大半 (audit_logs / project_members /
 *   recovery_codes / password_histories 等)。過去 run の関連レコードが残っていると
 *   DELETE で落ちる。UPSERT ならユーザ ID を固定したまま状態だけ初期化できる。
 */
export async function ensureInitialAdmin(email: string, password: string): Promise<string> {
  const pool = getPool();
  const passwordHash = await hash(password, BCRYPT_COST);
  // updated_at は Prisma @updatedAt でアプリ側更新する契約 (DB デフォルト無し)。
  const res = await pool.query(
    `INSERT INTO users (
       name, email, password_hash, system_role, is_active, force_password_change,
       mfa_enabled, mfa_secret_encrypted, mfa_enabled_at,
       failed_login_count, locked_until, permanent_lock,
       updated_at
     )
     VALUES ($1, $2, $3, 'admin', true, true, false, NULL, NULL, 0, NULL, false, NOW())
     ON CONFLICT (email) DO UPDATE SET
       password_hash = EXCLUDED.password_hash,
       is_active = true,
       force_password_change = true,
       mfa_enabled = false,
       mfa_secret_encrypted = NULL,
       mfa_enabled_at = NULL,
       failed_login_count = 0,
       locked_until = NULL,
       permanent_lock = false,
       updated_at = NOW()
     RETURNING id`,
    ['E2E 管理者', email, passwordHash],
  );
  return res.rows[0].id as string;
}

/**
 * RUN_ID 接頭辞に一致するテストデータを削除する (ベストエフォート)。
 * CI では Postgres コンテナ破棄で完全消去されるため、本処理は主にローカル実行時の
 * 残存防止用。
 *
 * 注意:
 *   users からの多くの FK は `ON DELETE RESTRICT`。過去 run で audit_logs や
 *   recovery_codes が残っていると DELETE が失敗する。ここでは関連テーブルも
 *   明示的に削除する (順序依存)。RUN_ID の prefix マッチで範囲を絞るため、
 *   他テストと衝突しない。
 */
export async function cleanupByRunId(runId: string): Promise<void> {
  const pool = getPool();
  const pattern = `%${runId}%`;

  // 1) 対象ユーザ ID を解決
  const userRes = await pool.query(
    'SELECT id FROM users WHERE email LIKE $1 OR name LIKE $1',
    [pattern],
  );
  const userIds = userRes.rows.map((r) => r.id as string);

  // 2) 対象プロジェクト ID を解決
  const projRes = await pool.query('SELECT id FROM projects WHERE name LIKE $1', [pattern]);
  const projectIds = projRes.rows.map((r) => r.id as string);

  // 3) RESTRICT FK 先を先に削除 (ベストエフォート、衝突は握り潰す)
  if (userIds.length > 0) {
    await safeExec(pool, 'DELETE FROM recovery_codes WHERE user_id = ANY($1)', [userIds]);
    await safeExec(pool, 'DELETE FROM password_histories WHERE user_id = ANY($1)', [userIds]);
    await safeExec(pool, 'DELETE FROM project_members WHERE user_id = ANY($1)', [userIds]);
    await safeExec(pool, 'DELETE FROM audit_logs WHERE user_id = ANY($1)', [userIds]);
    await safeExec(pool, 'DELETE FROM role_change_logs WHERE changed_by = ANY($1) OR target_user_id = ANY($1)', [userIds]);
    // SET NULL FK (auth_event_logs.user_id) は DELETE FROM users で勝手に NULL 化される
  }
  if (projectIds.length > 0) {
    await safeExec(pool, 'DELETE FROM project_members WHERE project_id = ANY($1)', [projectIds]);
    await safeExec(pool, 'DELETE FROM projects WHERE id = ANY($1)', [projectIds]);
  }
  if (userIds.length > 0) {
    await safeExec(pool, 'DELETE FROM users WHERE id = ANY($1)', [userIds]);
  }
}

async function safeExec(pool: Pool, sql: string, params: unknown[]): Promise<void> {
  try {
    await pool.query(sql, params);
  } catch (e) {
    // ローカル実行時のクリーンアップで FK エラー等があっても致命的ではない
    console.warn('[e2e cleanup] 無視可能なエラー:', (e as Error).message);
  }
}
