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
    // ADR-0016 (2026-05-20): User.email を tenant-scoped 一意化したため、
    //   email 単独検索は別テナントの同 email を誤判定する。初期管理者は DEFAULT_TENANT に
    //   作成する設計なので tenantId フィルタを併用する。
    const existing = await prisma.user.findFirst({
      where: { email, tenantId: DEFAULT_TENANT_ID, deletedAt: null },
    });

    if (existing) {
      // ADR-0016 Revised (2026-05-22): 冪等再実行時も DEFAULT_TENANT.createdByUserId を担保。
      //   migration backfill が 'admin' / 'super_admin' を対象とするが、過去の seed 実行時点で
      //   初期 admin が作られていても backfill 走行前のスナップショットでは紐付け漏れがありうる。
      //   既存 initial admin を「自前テナント保有」として明示的に紐付け、層 1 判定の integrity を担保。
      await prisma.tenant.update({
        where: { id: DEFAULT_TENANT_ID },
        data: { createdByUserId: existing.id },
      });
      console.log(`スキップ: ${email} は既に登録済みです (createdByUserId を再紐付け済)`);
    } else {
      // パスワードハッシュ化
      const passwordHash = await hash(password, BCRYPT_COST);

      // リカバリーコード生成
      const recoveryCodes: string[] = [];
      for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
        recoveryCodes.push(generateRecoveryCode());
      }

      // ユーザ作成 + リカバリーコード保存
      // ★severity-1 (fix/tenant-id-default-removal, 2026-05-28, ADR-0024):
      //   schema の DB DEFAULT 撤去に伴い tenantId を data に明示。初期 admin は
      //   DEFAULT_TENANT 所属。旧コードは DB DEFAULT に依存して silent 動作していた。
      const user = await prisma.user.create({
        data: {
          tenantId: DEFAULT_TENANT_ID,
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

      // ADR-0016 Revised (2026-05-22): DEFAULT_TENANT の created_by_user_id を初期 admin に紐付け。
      //   新規環境 seed では migration backfill 後に user.create するため、backfill 時点では NULL の
      //   ままだった可能性。ここで明示的に上書きすることで「初期 admin の email で公開 /signup を
      //   試した際の層 1 判定」が正しく block するようになる。
      await prisma.tenant.update({
        where: { id: DEFAULT_TENANT_ID },
        data: { createdByUserId: user.id },
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
 * 環境変数 (Netlify に登録):
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
      '⚠ super_admin user は作成スキップ (SUPER_ADMIN_INITIAL_EMAIL/PASSWORD/NAME 環境変数が未設定)',
    );
    console.log('  Netlify に環境変数を登録後、再実行してください:');
    console.log('    SUPER_ADMIN_INITIAL_EMAIL=admin@knowledge-relay-platform.admin');
    console.log('    SUPER_ADMIN_INITIAL_PASSWORD=<強固な初期パスワード>');
    console.log('    SUPER_ADMIN_INITIAL_NAME=Platform Admin');
    // ADR-0016 Revised (2026-05-22): super_admin user 未作成 = MANAGEMENT_TENANT.createdByUserId が
    //   NULL のまま残る可能性 (= migration backfill の対象が居ない)。後続で env 設定 + seed 再実行で
    //   超管理者作成パスが走り、createdByUserId は明示更新される。それまで MANAGEMENT を払い出した
    //   admin が公開 /signup で識別されない soft relaxation が発生するが、運営者 (super_admin) 自身が
    //   そもそも /signup 経路を使わないため実害なし。
    console.log('  注意: MANAGEMENT_TENANT.createdByUserId が NULL のままになります (= 後続再実行で解消)');
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
  // ADR-0016 (2026-05-20): super_admin は MANAGEMENT_TENANT 所属のため tenantId フィルタを併用
  //   (= 顧客テナントに同 email の admin が居ても誤判定しない)
  const existingSuperAdmin = await prisma.user.findFirst({
    where: { email: superAdminEmail, tenantId: MANAGEMENT_TENANT_ID, deletedAt: null },
  });

  if (existingSuperAdmin) {
    // ADR-0016 Revised (2026-05-22): 冪等再実行時も MANAGEMENT.createdByUserId を担保。
    //   migration backfill が 'admin' / 'super_admin' を対象とするが、過去の migration 適用
    //   時点で super_admin user が居なかったケース、運用での tenant 物理削除 + 復元、等で
    //   createdByUserId が NULL のまま残るケースを補正する。
    await prisma.tenant.update({
      where: { id: MANAGEMENT_TENANT_ID },
      data: { createdByUserId: existingSuperAdmin.id },
    });
    console.log(`スキップ: super_admin user (${superAdminEmail}) は既に登録済みです (createdByUserId を再紐付け済)`);
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

  // ADR-0016 Revised (2026-05-22): 管理テナントの created_by_user_id を super_admin に紐付け。
  //   migration の backfill SQL は「systemRole='admin' の最古 user」を推定するロジックだが、
  //   super_admin の systemRole は 'super_admin' (= 'admin' ではない) のため backfill 対象外。
  //   よって seed.ts で **明示的に super_admin user.id へ更新する**。これにより
  //   「super_admin email で公開 /signup を試した際の層 1 判定」が正しく block するようになる。
  //   既に backfill 等で別 user (顧客 admin 等) を指している可能性も考慮し、無条件で上書き。
  await prisma.tenant.update({
    where: { id: MANAGEMENT_TENANT_ID },
    data: { createdByUserId: superAdminUser.id },
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
