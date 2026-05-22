/**
 * staging/dev 専用: default テナントを Beginner プラン + 銀行振込払い + Stripe 関連全クリアにリセット
 *
 * 通常の運用では UI / API からはこのような変更は不可だが、staging での TC 再実施のため
 * SQL レベルで直接書き換える。
 *
 * PR #425 (2026-05-22) 改修:
 *   - 「Already beginner, no action.」早期 return を撤去 → 常に Stripe 関連全フィールドをクリア
 *   - clearTenantStripeSubscriptionFields と同等のフィールドをクリア (= TC 完全初期化)
 *
 * 使い方:
 *   $env:DATABASE_URL = "<staging Transaction pooler URL>"
 *   $env:DIRECT_URL   = "<staging Session pooler URL>"
 *   npx tsx scripts/reset-default-tenant-to-beginner.ts
 *
 * リセット後の状態 (= TC-1 / TC-2 / TC-3 等の開始可能な完全初期状態):
 *   - plan: 'beginner'
 *   - paymentMethod: 'invoice'
 *   - beginnerEverUpgraded: false
 *   - stripeSubscriptionId: null
 *   - stripeSubscriptionStatus: null
 *   - stripeSubscriptionItem*: null
 *   - stripeDefaultPaymentMethodId: null
 *   - cardVerificationStatus: null
 *   - cardLastVerifiedAt: null
 *   - autoSuspendScheduledAt: null
 *   - stripeCustomerId: 保持 (= 再 setup 時に再利用、Stripe 側 Customer は残す)
 *
 * 注意: Stripe Dashboard 側の Customer / Subscription は本 script では cancel されない。
 *   完全クリーンにしたい場合は別途 Stripe Dashboard で手動削除 or
 *   UI で 「銀行振込」 → 「請求先情報を更新」 (= cancelTenantStripeSubscription 経由) を実施。
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
      stripeCustomerId: true,
      stripeSubscriptionId: true,
      stripeSubscriptionStatus: true,
      stripeDefaultPaymentMethodId: true,
      cardVerificationStatus: true,
      cardLastVerifiedAt: true,
      autoSuspendScheduledAt: true,
    },
  });
  console.log(before);

  if (!before) {
    console.error('default tenant not found');
    process.exit(1);
  }

  const updated = await prisma.tenant.update({
    where: { id: before.id },
    data: {
      plan: 'beginner',
      beginnerEverUpgraded: false,
      paymentMethod: 'invoice',
      // Stripe Subscription 関連 (= UI cancel と同等にクリア、cancelTenantStripeSubscription 参考)
      stripeSubscriptionId: null,
      stripeSubscriptionStatus: null,
      stripeSubscriptionItemHaikuId: null,
      stripeSubscriptionItemSonnetId: null,
      stripeSubscriptionItemStorageId: null,
      // Stripe PaymentMethod / カード検証関連
      stripeDefaultPaymentMethodId: null,
      cardVerificationStatus: null,
      cardLastVerifiedAt: null,
      autoSuspendScheduledAt: null,
      // stripeCustomerId は保持 (= 再 setup 時に既存 Customer 再利用前提、Stripe 側 Customer は残す)
    },
    select: {
      id: true,
      slug: true,
      plan: true,
      beginnerEverUpgraded: true,
      paymentMethod: true,
      stripeCustomerId: true,
      stripeSubscriptionId: true,
      stripeSubscriptionStatus: true,
      stripeDefaultPaymentMethodId: true,
      cardVerificationStatus: true,
      cardLastVerifiedAt: true,
      autoSuspendScheduledAt: true,
    },
  });

  console.log('\n=== After ===');
  console.log(updated);
  console.log('\n✅ Reset complete. TC-1 / TC-2 / TC-3 等を最初からやり直し可能。');
  console.log('   stripeCustomerId は保持しています (= 再 setup 時に既存 Customer 再利用)。');
  console.log('   Stripe Dashboard 側の Customer / Subscription を完全削除したい場合は');
  console.log('   別途 Stripe Dashboard で手動操作してください。');

  await prisma.$disconnect();
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
