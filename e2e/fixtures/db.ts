/**
 * E2E DB ヘルパー (PR #92)
 *
 * 役割:
 *   Playwright プロセスから直接 Postgres にアクセスして、以下を行う:
 *   1. 初期 admin アカウントのシード (seed スクリプトと等価だが、idempotent に作り直せる)
 *   2. 実行後のデータクリーンアップ (RUN_ID 接頭辞に一致するユーザ/プロジェクトを削除)
 *
 *   prisma client は Next.js サーバ側と同じコネクション設定を使うが、Playwright
 *   の Node 実行環境で動くため、専用インスタンスを作成する。
 *
 * 前提:
 *   - DATABASE_URL 環境変数が設定されていること (CI では e2e.yml で設定)
 */

import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { hash } from 'bcryptjs';
import { PrismaClient } from '../../src/generated/prisma/client';
import { BCRYPT_COST } from '../../src/config/security';

let _prisma: PrismaClient | null = null;
let _pool: Pool | null = null;

export function getPrisma(): PrismaClient {
  if (_prisma) return _prisma;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL が未設定です。CI/ローカルで e2e 用 DB を設定してください。');
  }
  _pool = new Pool({ connectionString });
  const adapter = new PrismaPg(_pool);
  _prisma = new PrismaClient({ adapter });
  return _prisma;
}

export async function disconnectPrisma(): Promise<void> {
  if (_prisma) {
    await _prisma.$disconnect();
    _prisma = null;
  }
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}

/**
 * 初期 admin を作成する (既存があれば削除してから再作成)。
 * - forcePasswordChange: true (Step 1 で変更を要求)
 * - mfaEnabled: false (Step 2 で有効化)
 * - isActive: true (seed と同じ)
 */
export async function ensureInitialAdmin(email: string, password: string): Promise<string> {
  const prisma = getPrisma();
  // 冪等性: E2E 実行のたびに状態をリセット
  await prisma.user.deleteMany({ where: { email } });

  const passwordHash = await hash(password, BCRYPT_COST);
  const user = await prisma.user.create({
    data: {
      name: 'E2E 管理者',
      email,
      passwordHash,
      systemRole: 'admin',
      isActive: true,
      forcePasswordChange: true,
    },
  });
  return user.id;
}

/**
 * RUN_ID 接頭辞に一致するテストデータを削除する (ベストエフォート)。
 * CI では Postgres コンテナ破棄で完全消去されるが、ローカル実行時の残存防止用。
 */
export async function cleanupByRunId(runId: string): Promise<void> {
  const prisma = getPrisma();
  // projectMember → task / estimate / knowledge 等は project / user 削除で cascade
  await prisma.user.deleteMany({
    where: { OR: [{ email: { contains: runId } }, { name: { contains: runId } }] },
  });
  await prisma.project.deleteMany({ where: { name: { contains: runId } } });
}
