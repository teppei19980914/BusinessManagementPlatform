/**
 * 孤立ユーザレコードの削除スクリプト
 *
 * ADR-0016 (2026-05-20): multi-tenant user membership 対応で tenantSlug が必須化。
 *   同一 email が複数テナントに存在しうるため、削除対象を明示的にテナントで絞り込む。
 *   tenantSlug 無しで実行すると別テナントの同 email user を誤削除する severity-1 リスクあり。
 *
 * 使い方: npx tsx scripts/cleanup-orphan-user.ts <tenantSlug> <email>
 *   例: npx tsx scripts/cleanup-orphan-user.ts default user@example.com
 */
import 'dotenv/config';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';

const tenantSlug = process.argv[2];
const email = process.argv[3];

if (!tenantSlug || !email) {
  console.error('Usage: npx tsx scripts/cleanup-orphan-user.ts <tenantSlug> <email>');
  console.error('  例: npx tsx scripts/cleanup-orphan-user.ts default user@example.com');
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DIRECT_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  // ADR-0016: tenantSlug → tenantId 解決
  const tenant = await prisma.tenant.findFirst({
    where: { slug: tenantSlug, deletedAt: null },
    select: { id: true, name: true },
  });
  if (!tenant) {
    console.error(`Tenant not found: slug=${tenantSlug}`);
    process.exit(1);
  }
  console.log(`Target tenant: ${tenant.name} (id=${tenant.id})`);

  // ADR-0016: tenant 内で email 検索 (= 別テナント誤削除防止)
  const user = await prisma.user.findFirst({
    where: { email, tenantId: tenant.id },
  });
  if (!user) {
    console.log(`User not found in tenant ${tenantSlug}: ${email}`);
    return;
  }

  console.log(
    `Found: id=${user.id}, email=${user.email}, tenantId=${user.tenantId}, isActive=${user.isActive}, deletedAt=${user.deletedAt}`,
  );

  await prisma.$transaction([
    prisma.emailVerificationToken.deleteMany({ where: { userId: user.id } }),
    prisma.recoveryCode.deleteMany({ where: { userId: user.id } }),
    prisma.roleChangeLog.deleteMany({ where: { targetUserId: user.id } }),
    prisma.auditLog.deleteMany({ where: { entityId: user.id, entityType: 'user' } }),
    prisma.authEventLog.deleteMany({ where: { userId: user.id } }),
    prisma.user.delete({ where: { id: user.id } }),
  ]);

  console.log(`Deleted successfully: ${email} (tenant=${tenantSlug})`);
}

main()
  .catch(console.error)
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
