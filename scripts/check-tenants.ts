import 'dotenv/config';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';

async function main() {
  const pool = new Pool({ connectionString: process.env.DIRECT_URL });
  const adapter = new PrismaPg(pool);
  const prisma = new PrismaClient({ adapter });

  const tenants = await prisma.tenant.findMany({
    select: { id: true, slug: true, name: true, plan: true, deletedAt: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });

  console.log('=== Tenants ===');
  tenants.forEach((t) => {
    console.log(
      `slug=${t.slug.padEnd(20)} | plan=${(t.plan ?? 'null').padEnd(8)} | name=${t.name} | deleted=${t.deletedAt ? 'YES' : 'no'} | id=${t.id}`,
    );
  });

  const users = await prisma.user.findMany({
    select: {
      email: true,
      systemRole: true,
      isActive: true,
      tenantId: true,
      tenant: { select: { slug: true } },
    },
    orderBy: { createdAt: 'asc' },
  });

  console.log('\n=== Users ===');
  users.forEach((u) => {
    console.log(
      `email=${u.email.padEnd(45)} | role=${u.systemRole.padEnd(12)} | active=${u.isActive} | tenant=${u.tenant.slug}`,
    );
  });

  await prisma.$disconnect();
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
