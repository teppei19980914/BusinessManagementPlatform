/**
 * staging 専用: default テナントを Pro → Beginner に戻す (TC-1 やり直し用)
 *
 * 通常の運用では tenant-self.service.ts の BEGINNER_DOWNGRADE_FORBIDDEN ガードにより
 * UI/API からは不可能だが、staging での UAT 再実施のため SQL で直接書き換える。
 *
 * 使い方:
 *   $env:DATABASE_URL = "<staging Transaction pooler URL>"
 *   $env:DIRECT_URL   = "<staging Session pooler URL>"
 *   npx tsx scripts/reset-default-tenant-to-beginner.ts
 */
import 'dotenv/config';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';

async function main() {
  const pool = new Pool({ connectionString: process.env.DIRECT_URL });
  const adapter = new PrismaPg(pool);
  const prisma = new PrismaClient({ adapter });

  console.log('=== Before ===');
  const before = await prisma.tenant.findFirst({
    where: { slug: 'default' },
    select: {
      id: true,
      slug: true,
      name: true,
      plan: true,
      beginnerEverUpgraded: true,
      paymentMethod: true,
      stripeSubscriptionId: true,
      stripeSubscriptionStatus: true,
    },
  });
  console.log(before);

  if (!before) {
    console.error('default tenant not found');
    process.exit(1);
  }

  if (before.plan === 'beginner') {
    console.log('Already beginner, no action.');
    return;
  }

  const updated = await prisma.tenant.update({
    where: { id: before.id },
    data: {
      plan: 'beginner',
      beginnerEverUpgraded: false,
      // 念のため Stripe 関連 (現状 null のはずだが) もクリア
      stripeSubscriptionId: null,
      stripeSubscriptionStatus: null,
      stripeSubscriptionItemHaikuId: null,
      stripeSubscriptionItemSonnetId: null,
      stripeSubscriptionItemStorageId: null,
      // paymentMethod = 'invoice' に戻す (= 銀行振込)
      paymentMethod: 'invoice',
    },
    select: {
      id: true,
      slug: true,
      plan: true,
      beginnerEverUpgraded: true,
      paymentMethod: true,
      stripeSubscriptionId: true,
    },
  });

  console.log('\n=== After ===');
  console.log(updated);
  console.log('\n✅ Reset complete. TC-1 を最初からやり直し可能。');

  await prisma.$disconnect();
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
