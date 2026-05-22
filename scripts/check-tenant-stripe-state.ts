/**
 * staging 確認用: default テナントの Stripe 関連状態を表示
 */
import 'dotenv/config';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';

async function main() {
  const pool = new Pool({ connectionString: process.env.DIRECT_URL });
  const adapter = new PrismaPg(pool);
  const prisma = new PrismaClient({ adapter });

  const tenant = await prisma.tenant.findFirst({
    where: { slug: 'default' },
    select: {
      id: true,
      slug: true,
      name: true,
      plan: true,
      paymentMethod: true,
      stripeCustomerId: true,
      stripeSubscriptionId: true,
      stripeSubscriptionStatus: true,
      stripeDefaultPaymentMethodId: true,
      cardVerificationStatus: true,
      cardLastVerifiedAt: true,
    },
  });

  console.log('=== Default Tenant Stripe State ===');
  console.log(tenant);

  await prisma.$disconnect();
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
