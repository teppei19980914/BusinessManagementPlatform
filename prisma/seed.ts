/**
 * シードスクリプト: 初期管理者アカウント作成
 * 設計書: DESIGN.md セクション 13.1
 *
 * 使い方: pnpm db:seed
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
    // 冪等性: 既存ユーザがあればスキップ
    const existing = await prisma.user.findFirst({
      where: { email, deletedAt: null },
    });

    if (existing) {
      console.log(`スキップ: ${email} は既に登録済みです`);
      return;
    }

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
          create: await Promise.all(
            recoveryCodes.map(async (code) => ({
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
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

main().catch((e) => {
  console.error('シードエラー:', e);
  process.exit(1);
});
