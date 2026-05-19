/**
 * 請求業務管理サービス (PR-V7a / 2026-05-19)
 *
 * super_admin が銀行振込 (invoice) テナントの手動消込・例外対応を実行するためのサービス層。
 * credit_card の自動化されたフロー (= Stripe Webhook + cron) と対称な操作を提供する。
 *
 * 関連:
 *   - 仕様: docs/business/STRIPE_BILLING.md
 *   - API:  src/app/api/admin/super/billing/[id]/confirm-payment/route.ts
 *   - UI:   src/app/(dashboard)/admin/super/billing/[yearMonth]/page.tsx
 */

import { prisma } from '@/lib/db';

/**
 * Prisma の $transaction callback で渡される tx 型 (= billingHistory.updateMany を持つ最小限)。
 * 完全な PrismaClient 型を引きずると tx と prisma の互換が壊れるため、必要な model だけ宣言。
 */
type BillingHistoryTx = {
  billingHistory: {
    updateMany: (args: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }) => Promise<{ count: number }>;
  };
};

export type ConfirmInvoicePaymentResult =
  | { ok: true; id: string; paidAt: Date }
  | { ok: false; error: 'NOT_FOUND' | 'INVALID_PAYMENT_METHOD' | 'INVALID_STATUS' };

/**
 * 月途中で invoice → credit_card 切替時に、当月の pending 状態 invoice/bank_transfer 履歴を
 * `replaced_by_stripe` に置き換える (PR-V7a / 監査 G-4 二重課金防止)。
 *
 * 使用想定:
 *   - completeStripeSetup の Step 5 内で同一トランザクション内呼出 (= 整合性確保)
 *   - 将来的に super_admin が手動で切替えるケースでも再利用可
 *
 * @param tx Prisma の transaction client (= 同一トランザクション内呼出を強制)
 * @param tenantId 対象テナント
 * @param currentYearMonth テナント TZ 基準の現在月 (= 'YYYY-MM')
 * @returns 更新件数 (通常 0〜1、yearMonth UNIQUE 制約のため理論上 1 件まで)
 */
export async function markPendingInvoiceAsReplacedByStripe(
  tx: BillingHistoryTx,
  tenantId: string,
  currentYearMonth: string,
): Promise<number> {
  const result = await tx.billingHistory.updateMany({
    where: {
      tenantId,
      yearMonth: currentYearMonth,
      paymentMethod: { in: ['invoice', 'bank_transfer'] },
      status: 'pending',
    },
    data: {
      status: 'replaced_by_stripe',
    },
  });
  return result.count;
}

/**
 * 銀行振込 (invoice / bank_transfer) 請求書の入金確認を手動で実行する。
 *
 * - credit_card は Stripe Webhook (invoice.paid) で自動更新するため本 API では拒否
 * - status='pending' 以外は拒否 (= paid / failed / refunded / canceled / replaced_by_stripe)
 * - 操作者は confirmedBy + AuditLog の双方に記録 (= 監査要件)
 *
 * @param billingHistoryId - 対象 BillingHistory.id
 * @param userId - 実行 super_admin の User.id
 * @param paidAtOverride - 入金日 (任意、未指定なら now())
 */
export async function confirmInvoicePayment(
  billingHistoryId: string,
  userId: string,
  paidAtOverride?: Date,
): Promise<ConfirmInvoicePaymentResult> {
  const existing = await prisma.billingHistory.findUnique({
    where: { id: billingHistoryId },
  });
  if (!existing) {
    return { ok: false, error: 'NOT_FOUND' };
  }
  if (existing.paymentMethod === 'credit_card') {
    // credit_card は Stripe Webhook で自動消込される設計のため、手動操作は禁止
    return { ok: false, error: 'INVALID_PAYMENT_METHOD' };
  }
  if (existing.status !== 'pending') {
    // 既に paid / failed / refunded 等の遷移済レコードは再操作不可 (= 例外対応 API で別途)
    return { ok: false, error: 'INVALID_STATUS' };
  }

  const paidAt = paidAtOverride ?? new Date();

  await prisma.$transaction(async (tx) => {
    await tx.billingHistory.update({
      where: { id: billingHistoryId },
      data: {
        status: 'paid',
        paidAt,
        confirmedBy: userId,
        confirmedAt: new Date(),
      },
    });

    await tx.auditLog.create({
      data: {
        tenantId: existing.tenantId,
        userId,
        action: 'UPDATE',
        entityType: 'BillingHistory',
        entityId: billingHistoryId,
        beforeValue: {
          status: existing.status,
          paidAt: existing.paidAt,
        },
        afterValue: {
          status: 'paid',
          paidAt: paidAt.toISOString(),
          operation: 'manual_payment_confirmation',
        },
      },
    });
  });

  return { ok: true, id: billingHistoryId, paidAt };
}
