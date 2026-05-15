/**
 * super_admin E2E 用フィクスチャ (2026-05-11)
 *
 * 役割:
 *   super_admin ダッシュボードの請求業務正確性を E2E で検証するためのデータセット作成。
 *
 * 作成するデータ:
 *   - 管理テナント (= MANAGEMENT_TENANT_ID、既存) に super_admin user を 1 名作成
 *   - 顧客テナント 2 件 (各プラン x ストレージ add-on の組み合わせ)
 *     - tenantSeq / currentMonthApiCallCount / currentMonthApiCostJpy /
 *       storageAddonPlan / storageBytesUsed を明示的に設定
 *   - 各顧客テナントに admin user 1 名 (= activeUserCount=1 の検証用)
 *   - Default テナントには余分なユーザを作らない (= 既存 admin のみ)
 *
 * cleanup:
 *   - cleanupSuperAdminFixture で作成データをまるごと削除
 *   - Default テナントの既存データには手を入れない
 */

import { Pool } from 'pg';
import { randomBytes } from 'crypto';
import { hash } from 'bcryptjs';
import { BCRYPT_COST } from '../../src/config/security';

const MANAGEMENT_TENANT_ID = '00000000-0000-0000-0000-ffffffffffff';

let _pool: Pool | null = null;
function getPool(): Pool {
  if (_pool) return _pool;
  const cs = process.env.DATABASE_URL;
  if (!cs) throw new Error('DATABASE_URL が未設定です');
  _pool = new Pool({ connectionString: cs });
  return _pool;
}

export async function disconnectSuperAdminDb(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}

export type SuperAdminFixture = {
  superAdminId: string;
  superAdminEmail: string;
  superAdminPassword: string;
  /** 顧客テナント 1 (expert / plus): LLM ¥1500 (300 calls × ¥5、2026-05-15 改定後) + Storage ¥500 = ¥2000 */
  customerTenantA: {
    id: string;
    name: string;
    slug: string;
    adminEmail: string;
  };
  /** 顧客テナント 2 (pro / pro_storage): LLM ¥22500 (1500 calls × ¥15、2026-05-15 改定後) + Storage ¥1500 = ¥24000 */
  customerTenantB: {
    id: string;
    name: string;
    slug: string;
    adminEmail: string;
  };
};

/**
 * super_admin user + 顧客テナント 2 件 (請求金額が明確な組み合わせ) を作成する。
 *
 * @param runId  RUN_ID prefix (cleanup の検索キー)
 */
export async function setupSuperAdminFixture(runId: string): Promise<SuperAdminFixture> {
  const pool = getPool();
  const suffix = randomBytes(3).toString('hex');

  const superAdminEmail = `superadmin-${runId}-${suffix}@knowledge-relay-platform.admin`.toLowerCase();
  const superAdminPassword = process.env.E2E_SUPER_ADMIN_PASSWORD ?? `E2eSuper!Pw_${runId}`;
  const passwordHash = await hash(superAdminPassword, BCRYPT_COST);

  // 1. super_admin user (管理テナント所属、forcePasswordChange=false)
  const superAdminRes = await pool.query<{ id: string }>(
    `INSERT INTO users (
       tenant_id, name, email, password_hash, system_role,
       is_active, force_password_change, mfa_enabled,
       failed_login_count, permanent_lock, updated_at
     )
     VALUES ($1, $2, $3, $4, 'super_admin', true, false, false, 0, false, NOW())
     RETURNING id`,
    [MANAGEMENT_TENANT_ID, `Super Admin ${runId}`, superAdminEmail, passwordHash],
  );
  const superAdminId = superAdminRes.rows[0]!.id;

  // 2. 顧客テナント A: expert / plus = LLM ¥1500 (300 calls × ¥5、2026-05-15 改定後) + Storage ¥500
  // NOTE (PR #337 fix): name にも suffix を付与する。slug だけ一意では不十分。
  //   playwright が同一 spec を chromium / chromium-mobile 両 project で実行する場合、
  //   同一 worker process なら RUN_ID が共有されるため、suffix 無しの name だと
  //   2 行が異なる UUID + 同じ name で DB に並列存在し、E2E `getByText` の
  //   strict mode violation を引き起こす (KDD §5.X+35 参照)。
  const slugA = `e2e-sa-${runId}-${suffix}-a`;
  const nameA = `E2E Tenant A ${runId}-${suffix}`;
  const tenantA = await pool.query<{ id: string }>(
    `INSERT INTO tenants (
       slug, name, plan, current_month_api_call_count, current_month_api_cost_jpy,
       storage_addon_plan, storage_bytes_used,
       billing_type, billing_company_name, billing_contact_name, billing_contact_email,
       payment_method, created_at, updated_at
     )
     VALUES ($1, $2, 'expert', 300, 1500, 'plus', 0,
             'corporate', 'E2E Corp A', '担当者A', 'a@example.com',
             'invoice', NOW(), NOW())
     RETURNING id`,
    [slugA, nameA],
  );
  const tenantAId = tenantA.rows[0]!.id;

  // admin user (= activeUserCount=1 の検証用)
  const adminEmailA = `admin-sa-${runId}-${suffix}-a@example.com`.toLowerCase();
  await pool.query(
    `INSERT INTO users (
       tenant_id, name, email, password_hash, system_role,
       is_active, force_password_change, mfa_enabled,
       failed_login_count, permanent_lock, updated_at
     )
     VALUES ($1, $2, $3, $4, 'admin', true, false, false, 0, false, NOW())`,
    [tenantAId, `Admin A ${runId}`, adminEmailA, passwordHash],
  );

  // 3. 顧客テナント B: pro / pro_storage = LLM ¥22500 (1500 calls × ¥15、2026-05-15 改定後) + Storage ¥1500
  const slugB = `e2e-sa-${runId}-${suffix}-b`;
  const nameB = `E2E Tenant B ${runId}-${suffix}`; // 名前にも suffix (上記 nameA と同理由)
  const tenantB = await pool.query<{ id: string }>(
    `INSERT INTO tenants (
       slug, name, plan, current_month_api_call_count, current_month_api_cost_jpy,
       storage_addon_plan, storage_bytes_used,
       billing_type, billing_company_name, billing_contact_name, billing_contact_email,
       payment_method, created_at, updated_at
     )
     VALUES ($1, $2, 'pro', 1500, 22500, 'pro_storage', 524288000,
             'corporate', 'E2E Corp B', '担当者B', 'b@example.com',
             'invoice', NOW(), NOW())
     RETURNING id`,
    [slugB, nameB],
  );
  const tenantBId = tenantB.rows[0]!.id;

  const adminEmailB = `admin-sa-${runId}-${suffix}-b@example.com`.toLowerCase();
  await pool.query(
    `INSERT INTO users (
       tenant_id, name, email, password_hash, system_role,
       is_active, force_password_change, mfa_enabled,
       failed_login_count, permanent_lock, updated_at
     )
     VALUES ($1, $2, $3, $4, 'admin', true, false, false, 0, false, NOW())`,
    [tenantBId, `Admin B ${runId}`, adminEmailB, passwordHash],
  );

  return {
    superAdminId,
    superAdminEmail,
    superAdminPassword,
    customerTenantA: {
      id: tenantAId,
      name: nameA,
      slug: slugA,
      adminEmail: adminEmailA,
    },
    customerTenantB: {
      id: tenantBId,
      name: nameB,
      slug: slugB,
      adminEmail: adminEmailB,
    },
  };
}

export async function cleanupSuperAdminFixture(
  fixture: SuperAdminFixture | undefined,
): Promise<void> {
  if (!fixture) return;
  const pool = getPool();
  const tenantIds = [fixture.customerTenantA.id, fixture.customerTenantB.id];

  // NOTE (PR #337 fix, KDD §5.X+35): tenants 削除前に FK 子テーブルを先に消す。
  //   特に auth_event_logs は顧客 admin のログイン試行で生成され、tenants 削除を
  //   blocking する。旧 cleanup は DELETE FROM tenants 直叩きで FK 違反 → 残存 →
  //   次の project run (chromium-mobile) で同名 tenant が重複生成され、テスト
  //   getByText が 2 要素ヒットで strict mode violation を起こした。
  //   ベストエフォート方式 (各 DELETE 独立、catch で握り潰し継続)。
  const childDeletes: { label: string; sql: string }[] = [
    { label: 'auth_event_logs', sql: 'DELETE FROM auth_event_logs WHERE tenant_id = ANY($1)' },
    { label: 'audit_logs', sql: 'DELETE FROM audit_logs WHERE tenant_id = ANY($1)' },
    { label: 'system_error_logs', sql: 'DELETE FROM system_error_logs WHERE tenant_id = ANY($1)' },
    { label: 'api_call_logs', sql: 'DELETE FROM api_call_logs WHERE tenant_id = ANY($1)' },
    { label: 'role_change_logs', sql: 'DELETE FROM role_change_logs WHERE tenant_id = ANY($1)' },
    {
      label: 'email_verification_tokens',
      sql: 'DELETE FROM email_verification_tokens WHERE user_id IN (SELECT id FROM users WHERE tenant_id = ANY($1))',
    },
    {
      label: 'password_reset_tokens',
      sql: 'DELETE FROM password_reset_tokens WHERE user_id IN (SELECT id FROM users WHERE tenant_id = ANY($1))',
    },
    {
      label: 'recovery_codes',
      sql: 'DELETE FROM recovery_codes WHERE user_id IN (SELECT id FROM users WHERE tenant_id = ANY($1))',
    },
    {
      label: 'password_histories',
      sql: 'DELETE FROM password_histories WHERE user_id IN (SELECT id FROM users WHERE tenant_id = ANY($1))',
    },
    {
      label: 'sessions',
      sql: 'DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE tenant_id = ANY($1))',
    },
  ];
  for (const step of childDeletes) {
    try {
      await pool.query(step.sql, [tenantIds]);
    } catch (e) {
      console.warn(
        `[super-admin cleanup] DELETE ${step.label} 失敗 (継続): ${(e as Error).message}`,
      );
    }
  }

  // 顧客テナント A/B のユーザを削除 → テナント削除
  try {
    await pool.query('DELETE FROM users WHERE tenant_id = ANY($1)', [tenantIds]);
  } catch (e) {
    console.warn(`[super-admin cleanup] DELETE users 失敗: ${(e as Error).message}`);
  }
  try {
    await pool.query('DELETE FROM tenants WHERE id = ANY($1)', [tenantIds]);
  } catch (e) {
    console.warn(`[super-admin cleanup] DELETE tenants 失敗: ${(e as Error).message}`);
  }

  // super_admin user を削除 (= 管理テナントには触らない)
  // super_admin の auth_event_logs (login_success など) も先に消す必要がある。
  try {
    await pool.query('DELETE FROM auth_event_logs WHERE user_id = $1', [fixture.superAdminId]);
  } catch (e) {
    console.warn(
      `[super-admin cleanup] DELETE auth_event_logs (super_admin) 失敗: ${(e as Error).message}`,
    );
  }
  try {
    await pool.query('DELETE FROM users WHERE id = $1', [fixture.superAdminId]);
  } catch (e) {
    console.warn(`[super-admin cleanup] DELETE super_admin user 失敗: ${(e as Error).message}`);
  }
}
