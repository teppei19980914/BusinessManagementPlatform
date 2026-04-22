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

  // 1) 対象 ID を解決 (users と projects は相互独立なので並列)
  const [userRes, projRes] = await Promise.all([
    pool.query<{ id: string }>(
      'SELECT id FROM users WHERE email LIKE $1 OR name LIKE $1',
      [pattern],
    ),
    pool.query<{ id: string }>('SELECT id FROM projects WHERE name LIKE $1', [pattern]),
  ]);
  const userIds = userRes.rows.map((r) => r.id);
  const projectIds = projRes.rows.map((r) => r.id);

  // 2) transaction で 2 段階削除 (FK 先 → 親)。クリーンアップは best-effort なので
  //    transaction 単位で失敗したらログだけ出して続行する。
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (userIds.length > 0 || projectIds.length > 0) {
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

      // 2-b) 親テーブルを削除 (projects → users の順: users.id を参照する FK は既に消えた状態)
      if (projectIds.length > 0) {
        await client.query('DELETE FROM projects WHERE id = ANY($1)', [projectIds]);
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
