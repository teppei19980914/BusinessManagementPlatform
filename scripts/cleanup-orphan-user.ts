/**
 * 孤立ユーザレコードの削除スクリプト
 * 使い方: npx tsx scripts/cleanup-orphan-user.ts <email>
 */
import 'dotenv/config';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';

const email = process.argv[2];
if (!email) {
  console.error('Usage: npx tsx scripts/cleanup-orphan-user.ts <email>');
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DIRECT_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  const user = await prisma.user.findFirst({ where: { email } });
  if (!user) {
    console.log(`User not found: ${email}`);
    return;
  }

  console.log(
    `Found: id=${user.id}, email=${user.email}, isActive=${user.isActive}, deletedAt=${user.deletedAt}`,
  );

  await prisma.$transaction([
    prisma.emailVerificationToken.deleteMany({ where: { userId: user.id } }),
    prisma.recoveryCode.deleteMany({ where: { userId: user.id } }),
    prisma.roleChangeLog.deleteMany({ where: { targetUserId: user.id } }),
    prisma.auditLog.deleteMany({ where: { entityId: user.id, entityType: 'user' } }),
    prisma.authEventLog.deleteMany({ where: { userId: user.id } }),
    prisma.user.delete({ where: { id: user.id } }),
  ]);

  console.log(`Deleted successfully: ${email}`);
}

main()
  .catch(console.error)
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
