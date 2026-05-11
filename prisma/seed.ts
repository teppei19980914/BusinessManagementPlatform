/**
 * シードスクリプト: 初期管理者アカウント作成 + 管理テナント + super_admin user (PR-X1 で拡張)
 * 設計書: DESIGN.md セクション 13.1 / docs/roadmap/ROLE_REFACTORING_PLAN.md §3.1
 *
 * 使い方: pnpm db:seed
 *
 * PR-X1 (2026-05-07): 管理テナント (Knowledge Relay Platform) と super_admin user の
 * 自動 seed を追加。SUPER_ADMIN_INITIAL_EMAIL/PASSWORD/NAME 環境変数が設定されている場合のみ作成 (冪等)。
 */
import 'dotenv/config';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';
import { hash } from 'bcryptjs';
import { randomBytes } from 'crypto';
import {
  BCRYPT_COST,
  RECOVERY_CODE_COUNT,
  RECOVERY_CODE_CHARSET,
  PASSWORD_MIN_LENGTH,
  PASSWORD_REQUIRED_CHAR_TYPE_COUNT,
} from '../src/config/security';
import { DEFAULT_TENANT_ID, MANAGEMENT_TENANT_ID, MANAGEMENT_TENANT_SLUG } from '../src/lib/tenant';

function generateRecoveryCode(): string {
  const bytes = randomBytes(8);
  return Array.from(bytes)
    .map((b) => RECOVERY_CODE_CHARSET[b % RECOVERY_CODE_CHARSET.length])
    .join('')
    .replace(/(.{4})(.{4})/, '$1-$2');
}

async function main() {
  const email = process.env.INITIAL_ADMIN_EMAIL;
  const password = process.env.INITIAL_ADMIN_PASSWORD;

  if (!email || !password) {
    console.error('エラー: INITIAL_ADMIN_EMAIL と INITIAL_ADMIN_PASSWORD を .env に設定してください');
    process.exit(1);
  }

  // パスワードポリシーチェック（簡易版）
  if (password.length < PASSWORD_MIN_LENGTH) {
    console.error(`エラー: パスワードは${PASSWORD_MIN_LENGTH}文字以上で設定してください`);
    process.exit(1);
  }

  const types = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/];
  if (types.filter((r) => r.test(password)).length < PASSWORD_REQUIRED_CHAR_TYPE_COUNT) {
    console.error(`エラー: パスワードは英大文字・英小文字・数字・記号のうち${PASSWORD_REQUIRED_CHAR_TYPE_COUNT}種以上を含めてください`);
    process.exit(1);
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const adapter = new PrismaPg(pool);
  const prisma = new PrismaClient({ adapter });

  try {
    // 冪等性: 既存の初期管理者ユーザがあれば作成をスキップ (リターンはしない)
    //   PR-X1 (2026-05-07): 管理テナント + super_admin の seed は **既存初期管理者の有無に関わらず実行**。
    //   旧実装では `if (existing) return;` で早期 return していたため、初期 admin 投入済の本番で
    //   2 回目以降の seed が super_admin を作成しないバグがあった。
    const existing = await prisma.user.findFirst({
      where: { email, deletedAt: null },
    });

    if (existing) {
      console.log(`スキップ: ${email} は既に登録済みです (初期管理者作成は飛ばします)`);
    } else {
      // パスワードハッシュ化
      const passwordHash = await hash(password, BCRYPT_COST);

      // リカバリーコード生成
      const recoveryCodes: string[] = [];
      for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
        recoveryCodes.push(generateRecoveryCode());
      }

      // ユーザ作成 + リカバリーコード保存
      const user = await prisma.user.create({
        data: {
          name: '管理者',
          email,
          passwordHash,
          systemRole: 'admin',
          isActive: true,
          forcePasswordChange: true,
          recoveryCodes: {
            // Phase 2-10: tenantId 必須化。初期 admin は default-tenant 所属。
            create: await Promise.all(
              recoveryCodes.map(async (code) => ({
                tenantId: DEFAULT_TENANT_ID,
                codeHash: await hash(code, BCRYPT_COST),
              })),
            ),
          },
        },
      });

      console.log('');
      console.log('=== 初期管理者アカウント作成 ===');
      console.log(`メール:           ${user.email}`);
      console.log('初回ログイン後にパスワード変更が強制されます');
      console.log('');
      console.log('リカバリーコード:');
      recoveryCodes.forEach((code, i) => {
        console.log(`  ${String(i + 1).padStart(2, ' ')}. ${code}`);
      });
      console.log('');
      console.log('このリカバリーコードを安全な場所に保管してください。');
      console.log('再表示はできません。');
      console.log('================================');
      console.log('');
    }

    // PR-X1 (2026-05-07): 管理テナント + super_admin user の seed (env 変数が揃っていれば作成)。
    //   既存初期管理者がいる場合 (本番の通常状態) でも必ず実行される。
    await seedManagementTenantAndSuperAdmin(prisma);
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

/**
 * PR-X1: 管理テナント (Knowledge Relay Platform) と super_admin user を seed する。
 *
 * 動作:
 *   1. 管理テナント (UUID FFFFFFFFFFFF) を upsert (なければ作成、あれば何もしない)
 *   2. SUPER_ADMIN_INITIAL_EMAIL/PASSWORD/NAME が揃っていれば super_admin user を upsert
 *   3. user は管理テナントに所属、forcePasswordChange=true (初回ログイン時に強制変更)
 *
 * 環境変数 (Vercel に登録):
 *   - SUPER_ADMIN_INITIAL_EMAIL  (例: admin@knowledge-relay-platform.admin)
 *   - SUPER_ADMIN_INITIAL_PASSWORD (強固な初期パスワード)
 *   - SUPER_ADMIN_INITIAL_NAME   (例: Platform Admin)
 *
 * いずれかが未設定なら user 作成はスキップ (テナントだけは作成、後で env 設定してから再実行)。
 */
async function seedManagementTenantAndSuperAdmin(prisma: PrismaClient): Promise<void> {
  console.log('=== PR-X1: 管理テナント + super_admin user seed ===');

  // 1. 管理テナントを upsert (冪等性: 既存があれば更新せず維持)
  const existingTenant = await prisma.tenant.findUnique({
    where: { id: MANAGEMENT_TENANT_ID },
  });

  if (!existingTenant) {
    await prisma.tenant.create({
      data: {
        id: MANAGEMENT_TENANT_ID,
        slug: MANAGEMENT_TENANT_SLUG,
        name: 'Knowledge Relay Platform',
        plan: 'pro',
        // tenantSeq は明示的に null (= 顧客連番外、案 D 仕様)
        // monthlyBudgetCapJpy は null (無制限、運営内部のため課金対象外)
      },
    });
    console.log(`✅ 管理テナント作成: ${MANAGEMENT_TENANT_ID} (Knowledge Relay Platform)`);
  } else {
    console.log(`スキップ: 管理テナントは既に存在します (${MANAGEMENT_TENANT_ID})`);
  }

  // 2. super_admin user の env 確認
  const superAdminEmail = process.env.SUPER_ADMIN_INITIAL_EMAIL;
  const superAdminPassword = process.env.SUPER_ADMIN_INITIAL_PASSWORD;
  const superAdminName = process.env.SUPER_ADMIN_INITIAL_NAME;

  if (!superAdminEmail || !superAdminPassword || !superAdminName) {
    console.log('');
    console.log(
      'ℹ super_admin user は作成スキップ (SUPER_ADMIN_INITIAL_EMAIL/PASSWORD/NAME 環境変数が未設定)',
    );
    console.log('  Vercel に環境変数を登録後、再実行してください:');
    console.log('    SUPER_ADMIN_INITIAL_EMAIL=admin@knowledge-relay-platform.admin');
    console.log('    SUPER_ADMIN_INITIAL_PASSWORD=<強固な初期パスワード>');
    console.log('    SUPER_ADMIN_INITIAL_NAME=Platform Admin');
    console.log('================================');
    console.log('');
    return;
  }

  // パスワードポリシーチェック (簡易版、共通ポリシー)
  if (superAdminPassword.length < PASSWORD_MIN_LENGTH) {
    console.error(
      `エラー: SUPER_ADMIN_INITIAL_PASSWORD は${PASSWORD_MIN_LENGTH}文字以上で設定してください`,
    );
    return;
  }
  const types = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/];
  if (types.filter((r) => r.test(superAdminPassword)).length < PASSWORD_REQUIRED_CHAR_TYPE_COUNT) {
    console.error(
      `エラー: SUPER_ADMIN_INITIAL_PASSWORD は英大文字・英小文字・数字・記号のうち${PASSWORD_REQUIRED_CHAR_TYPE_COUNT}種以上を含めてください`,
    );
    return;
  }

  // 3. super_admin user を冪等作成
  const existingSuperAdmin = await prisma.user.findFirst({
    where: { email: superAdminEmail, deletedAt: null },
  });

  if (existingSuperAdmin) {
    console.log(`スキップ: super_admin user (${superAdminEmail}) は既に登録済みです`);
    return;
  }

  const superAdminPasswordHash = await hash(superAdminPassword, BCRYPT_COST);
  const superAdminRecoveryCodes: string[] = [];
  for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
    superAdminRecoveryCodes.push(generateRecoveryCode());
  }

  const superAdminUser = await prisma.user.create({
    data: {
      tenantId: MANAGEMENT_TENANT_ID,
      name: superAdminName,
      email: superAdminEmail,
      passwordHash: superAdminPasswordHash,
      systemRole: 'super_admin',
      isActive: true,
      forcePasswordChange: true,
      recoveryCodes: {
        // Phase 2-10: tenantId 必須化。super_admin は管理テナント所属。
        create: await Promise.all(
          superAdminRecoveryCodes.map(async (code) => ({
            tenantId: MANAGEMENT_TENANT_ID,
            codeHash: await hash(code, BCRYPT_COST),
          })),
        ),
      },
    },
  });

  console.log('');
  console.log(`✅ super_admin user 作成: ${superAdminUser.email}`);
  console.log(`   tenantId: ${MANAGEMENT_TENANT_ID} (管理テナント)`);
  console.log(`   systemRole: super_admin`);
  console.log('   初回ログイン後にパスワード変更が強制されます');
  console.log('');
  console.log('リカバリーコード (super_admin):');
  superAdminRecoveryCodes.forEach((code, i) => {
    console.log(`  ${String(i + 1).padStart(2, ' ')}. ${code}`);
  });
  console.log('');
  console.log('このリカバリーコードを安全な場所に保管してください。');
  console.log('再表示はできません。');
  console.log('================================');
  console.log('');
}

main().catch((e) => {
  console.error('シードエラー:', e);
  process.exit(1);
});
