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
  /** 顧客テナント 1 (expert / plus): LLM ¥1500 + Storage ¥500 = ¥2000
   *
   * ADR-0019 (2026-05-24): featureUnit を `project-upsert` (= 課金対象) で seed。
   *   旧 fixture は `risk-issue-embedding` を使っていたが、ADR-0019 で `*-embedding` 系は
   *   無料化されたため、super_admin ダッシュボード集計 (`BILLABLE_FEATURE_UNITS` フィルタ)
   *   が ¥0 を返し E2E が失敗した (KDD §5.X+127)。
   *   費用 ¥1500 は ApiCallLog.costJpy に直接書き込む値で、計算根拠は問わない (test fixture)。
   */
  customerTenantA: {
    id: string;
    name: string;
    slug: string;
    adminEmail: string;
  };
  /** 顧客テナント 2 (pro / pro_storage): LLM ¥22500 + Storage ¥1500 = ¥24000
   *
   * ADR-0019: featureUnit を `project-upsert` (= 課金対象) で seed (同上、tenantA と同型)。
   *   ¥22500 は ApiCallLog.costJpy 直接書き込み。
   */
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

  // PR-V8.2 (2026-05-19) ★fixture 自己完結化★: 管理テナント (MANAGEMENT_TENANT_ID) を保証する。
  //   E2E は通常 `pnpm db:seed` で管理テナントが seed されている前提だが、CI で並列実行する
  //   別 spec の cleanup 失敗 / DB reset タイミング / seed 未完了で MANAGEMENT_TENANT_ID 行が
  //   存在しない瞬間があり、本 fixture の super_admin user INSERT が users_tenant_id_fkey で
  //   FK 違反になる事象が発生 (CI run 26093793392)。
  //   fixture は外部状態 (seed) に依存しないよう自己完結させるべき (= KDD §5.X+81)。
  //   ON CONFLICT で既存行があれば no-op、なければ INSERT する idempotent な seed。
  await pool.query(
    `INSERT INTO tenants (
       id, slug, name, plan, payment_method, created_at, updated_at
     )
     -- ADR-0016 (2026-05-20): production seed.ts と同じ slug='platform-admin' に統一。
     --   旧 'mgmt' は spec 12 が 'platform-admin' で先に INSERT した場合に ON CONFLICT
     --   DO NOTHING で残るため、spec 13 が tenantSlug='mgmt' でログインすると tenant_not_found。
     VALUES ($1, 'platform-admin', 'Knowledge Relay Platform', 'pro', 'invoice', NOW(), NOW())
     ON CONFLICT (id) DO NOTHING`,
    [MANAGEMENT_TENANT_ID],
  );

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

  // ADR-0016 Revised (2026-05-22): MANAGEMENT テナントの created_by_user_id を super_admin に紐付け。
  //   ON CONFLICT DO NOTHING で MANAGEMENT 行は冪等に作成されるが、created_by_user_id は migration の
  //   backfill SQL に委ねられる。fixture では super_admin user を新規 INSERT する都度、最新の id へ
  //   明示的に上書きすることで「fixture 自己完結化」を担保 (= 3 層判定の integrity 担保)。
  //   既に他 fixture が createdBy をセット済みの場合も最新の super_admin を指すように上書きする。
  await pool.query(
    `UPDATE tenants SET created_by_user_id = $1 WHERE id = $2`,
    [superAdminId, MANAGEMENT_TENANT_ID],
  );

  // 2. 顧客テナント A: expert / plus = LLM ¥1500 + Storage ¥500
  //   ADR-0019 (2026-05-24): super_admin 画面の集計が `BILLABLE_FEATURE_UNITS` フィルタを
  //   持つため、fixture は **課金対象 featureUnit (= project-upsert)** で seed する必要がある。
  //   旧 fixture は `risk-issue-embedding` を使っていたが、これは ADR-0019 で無料化されたため
  //   集計から除外され ¥0 表示になり E2E 失敗 → KDD §5.X+127 で記録。
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

  // PR-V8.1 (2026-05-19): super_admin 画面表示が ApiCallLog SUM (真値) ベースに変わったため、
  //   tenant counter と整合する ApiCallLog レコードを seed する。counter (1 calls / ¥1500)
  //   に揃え、件数と費用合計が一致する代表 1 行を作る (= drift なし状態)。
  // ADR-0019 (2026-05-24): featureUnit は **課金対象** (= BILLABLE_FEATURE_UNITS) でなければ
  //   集計フィルタで除外されるため、`project-upsert` を使う。旧 `risk-issue-embedding` は無料化済。
  // 2026-05-19: api_call_logs.request_id は NOT NULL (VarChar(64))。fixture でも明示必須。
  await pool.query(
    `INSERT INTO api_call_logs (
       tenant_id, feature_unit, model_name, cost_jpy, latency_ms, request_id, created_at
     )
     VALUES ($1, 'project-upsert', 'claude-haiku-4-5', 1500, 100, $2, NOW())`,
    [tenantAId, `e2e-sa-${runId}-${suffix}-a-req`],
  );
  // counter を ApiCallLog SUM と一致させる (1 件 / ¥1500)
  await pool.query(
    `UPDATE tenants
     SET current_month_api_call_count = 1, current_month_api_cost_jpy = 1500
     WHERE id = $1`,
    [tenantAId],
  );

  // admin user (= activeUserCount=1 の検証用)
  const adminEmailA = `admin-sa-${runId}-${suffix}-a@example.com`.toLowerCase();
  const adminARes = await pool.query<{ id: string }>(
    `INSERT INTO users (
       tenant_id, name, email, password_hash, system_role,
       is_active, force_password_change, mfa_enabled,
       failed_login_count, permanent_lock, updated_at
     )
     VALUES ($1, $2, $3, $4, 'admin', true, false, false, 0, false, NOW())
     RETURNING id`,
    [tenantAId, `Admin A ${runId}`, adminEmailA, passwordHash],
  );
  // ADR-0016 Revised (2026-05-22): tenantA の created_by_user_id を admin A に紐付け (3 層判定担保)
  await pool.query(
    `UPDATE tenants SET created_by_user_id = $1 WHERE id = $2`,
    [adminARes.rows[0]!.id, tenantAId],
  );

  // 3. 顧客テナント B: pro / pro_storage = LLM ¥22500 + Storage ¥1500
  //   ADR-0019: featureUnit は課金対象 `project-upsert` で seed (旧 `project-embedding` は無効)。
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

  // PR-V8.1 (2026-05-19): tenantA と同様、ApiCallLog seed + counter 整合
  //   pro プラン ¥22500 を代表 1 行で表現 (counter も 1 / ¥22500 に揃える、drift なし状態)
  // ADR-0019 (2026-05-24): featureUnit は課金対象 `project-upsert` (旧 `project-embedding` は
  //   現在 BILLABLE_FEATURE_UNITS に含まれていないため集計除外される、KDD §5.X+127)。
  await pool.query(
    `INSERT INTO api_call_logs (
       tenant_id, feature_unit, model_name, cost_jpy, latency_ms, request_id, created_at
     )
     VALUES ($1, 'project-upsert', 'claude-sonnet-4-6', 22500, 200, $2, NOW())`,
    [tenantBId, `e2e-sa-${runId}-${suffix}-b-req`],
  );
  await pool.query(
    `UPDATE tenants
     SET current_month_api_call_count = 1, current_month_api_cost_jpy = 22500
     WHERE id = $1`,
    [tenantBId],
  );

  const adminEmailB = `admin-sa-${runId}-${suffix}-b@example.com`.toLowerCase();
  const adminBRes = await pool.query<{ id: string }>(
    `INSERT INTO users (
       tenant_id, name, email, password_hash, system_role,
       is_active, force_password_change, mfa_enabled,
       failed_login_count, permanent_lock, updated_at
     )
     VALUES ($1, $2, $3, $4, 'admin', true, false, false, 0, false, NOW())
     RETURNING id`,
    [tenantBId, `Admin B ${runId}`, adminEmailB, passwordHash],
  );
  // ADR-0016 Revised (2026-05-22): tenantB の created_by_user_id を admin B に紐付け (3 層判定担保)
  await pool.query(
    `UPDATE tenants SET created_by_user_id = $1 WHERE id = $2`,
    [adminBRes.rows[0]!.id, tenantBId],
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
  // PR-V8 (2026-05-19): 本番 DB に対する DELETE 事故を防ぐ最終ガード。
  //   本 fixture は `DELETE FROM api_call_logs` / `audit_logs` 等の破壊的 SQL を含むため、
  //   万が一 NODE_ENV=production で接続された場合に即 throw する。
  //   通常運用では Playwright config が NODE_ENV='test' を強制するため通常は発火しない。
  if (process.env['NODE_ENV'] === 'production') {
    throw new Error(
      '[super-admin fixture] cleanup を NODE_ENV=production で実行しようとしました。'
      + ' 本 fixture は破壊的 DELETE を含むため本番 DB では絶対に実行できません。'
      + ' Playwright config の NODE_ENV を確認してください。',
    );
  }
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
