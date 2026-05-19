/**
 * Stripe ↔ DB 月次照合サービス (PR-V7 #5 / 2026-05-19)
 *
 * 役割:
 *   credit_card 払いテナントの `tenant.stripeSubscriptionStatus` が Stripe 側の真の状態と
 *   一致しているか月次で照合し、乖離があれば DB を Stripe 値で上書き + auditLog に記録する。
 *
 * 解決する問題 (= STRIPE_BILLING.md §6.3):
 *   Webhook 配信遅延 / 永続失敗 (DLQ 行) で DB 側の状態が古いまま放置されると、引落失敗
 *   テナントが「DB は active なのに Stripe は canceled」のような乖離状態に陥り、
 *   サービス継続判定 / 自動 suspend / resume 等の業務ロジックが誤動作する。
 *
 * 設計方針:
 *   - **月初 cron で全 credit_card テナントを照合** (テナント数が増えたら batched 化検討)
 *   - **Stripe を信頼源** (= 不一致は DB を Stripe 値で上書き、Stripe には書き戻さない)
 *   - **lost_subscription** (= Stripe 側で Subscription 自体が削除済) は status='canceled' に補正
 *   - 1 件失敗で cron 全体は止めない (per-tenant try/catch)
 *   - 失敗時は recordError でログ + 結果 errors 配列に追加 (= super_admin 調査用)
 *
 * 関連:
 *   - 仕様: docs/business/STRIPE_BILLING.md §6.3
 *   - 呼出 route: src/app/api/cron/stripe-reconcile/route.ts
 *   - schedule: vercel.json `0 6 1 * *` (= 毎月 1 日 06:00 UTC = JST 15:00)
 */

import type Stripe from 'stripe';
import { prisma } from '@/lib/db';
import { isStripeEnabled, getStripe } from '@/lib/stripe';
import { withStripeError } from '@/lib/stripe-error-handler';
import { recordError } from './error-log.service';

export type ReconcileResult = {
  /** 照合対象テナント数 (= credit_card + stripeSubscriptionId あり) */
  candidates: number;
  /** DB と Stripe で一致していた件数 (= 補正不要) */
  matched: number;
  /** 不一致を検知し DB を Stripe 値で補正した件数 */
  corrected: number;
  /** Stripe 側で Subscription が見つからず status='canceled' に補正した件数 */
  lostAndCanceled: number;
  /** 照合 / 補正失敗 (= 運用調査) */
  errors: Array<{ tenantId: string; error: string }>;
  /** Stripe 無効 (= STRIPE_ENABLED!=='true') による早期 return */
  skippedStripeDisabled?: true;
};

/**
 * credit_card 払いテナント全件を Stripe で照合し、乖離なら DB を Stripe 値で上書き。
 */
export async function reconcileStripeSubscriptions(): Promise<ReconcileResult> {
  if (!isStripeEnabled()) {
    return {
      candidates: 0,
      matched: 0,
      corrected: 0,
      lostAndCanceled: 0,
      errors: [],
      skippedStripeDisabled: true,
    };
  }

  const candidates = await prisma.tenant.findMany({
    where: {
      paymentMethod: 'credit_card',
      stripeSubscriptionId: { not: null },
      deletedAt: null,
    },
    select: {
      id: true,
      stripeSubscriptionId: true,
      stripeSubscriptionStatus: true,
    },
  });

  let matched = 0;
  let corrected = 0;
  let lostAndCanceled = 0;
  const errors: ReconcileResult['errors'] = [];

  const stripe = getStripe();

  for (const t of candidates) {
    try {
      const result = await withStripeError<Stripe.Subscription>(() =>
        stripe.subscriptions.retrieve(t.stripeSubscriptionId!),
      );

      if (!result.ok) {
        // Stripe で Subscription が見つからない = invalid_request + "No such subscription"
        if (
          result.code === 'invalid_request' &&
          /no such subscription/i.test(result.detail)
        ) {
          if (t.stripeSubscriptionStatus !== 'canceled') {
            await prisma.tenant.update({
              where: { id: t.id },
              data: { stripeSubscriptionStatus: 'canceled' },
            });
            await prisma.auditLog.create({
              data: {
                tenantId: t.id,
                userId: t.id, // system 操作。tenantId を流用 (entityId と同じ)
                action: 'UPDATE',
                entityType: 'tenant',
                entityId: t.id,
                beforeValue: { stripeSubscriptionStatus: t.stripeSubscriptionStatus },
                afterValue: {
                  stripeSubscriptionStatus: 'canceled',
                  reason: 'stripe_reconcile_lost_subscription',
                },
              },
            });
            lostAndCanceled++;
          } else {
            matched++;
          }
          continue;
        }
        // それ以外の Stripe API エラーは errors に追加
        errors.push({ tenantId: t.id, error: `${result.code}: ${result.userMessage}` });
        await recordError({
          severity: 'error',
          source: 'cron',
          message: `Stripe reconcile API failed (tenant=${t.id})`,
          context: {
            kind: 'stripe_reconcile',
            tenantId: t.id,
            errorCode: result.code,
            userMessage: result.userMessage,
          },
        });
        continue;
      }

      // 状態が一致するか確認
      const stripeStatus = result.value.status; // 'active' | 'past_due' | 'canceled' | ...
      if (stripeStatus === t.stripeSubscriptionStatus) {
        matched++;
      } else {
        await prisma.tenant.update({
          where: { id: t.id },
          data: { stripeSubscriptionStatus: stripeStatus },
        });
        await prisma.auditLog.create({
          data: {
            tenantId: t.id,
            userId: t.id,
            action: 'UPDATE',
            entityType: 'tenant',
            entityId: t.id,
            beforeValue: { stripeSubscriptionStatus: t.stripeSubscriptionStatus },
            afterValue: {
              stripeSubscriptionStatus: stripeStatus,
              reason: 'stripe_reconcile_corrected_drift',
            },
          },
        });
        corrected++;
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      errors.push({ tenantId: t.id, error: message });
      await recordError({
        severity: 'error',
        source: 'cron',
        message: `Stripe reconcile unexpected error (tenant=${t.id})`,
        context: { kind: 'stripe_reconcile', tenantId: t.id, error: message },
      });
    }
  }

  return {
    candidates: candidates.length,
    matched,
    corrected,
    lostAndCanceled,
    errors,
  };
}

// ============================================================
// §2. Stripe Invoice 金額 ↔ DB BillingHistory 金額の照合 (PR-V7a B-2 / 監査 C-G2)
// ============================================================

import { AMOUNT_RECONCILE_TOLERANCE_JPY } from '@/config/billing';

export type AmountReconcileResult = {
  /** 照合対象件数 (= 直近 N ヶ月の credit_card BillingHistory with stripeInvoiceId) */
  candidates: number;
  /** 金額が完全一致 (= ±tolerance 以内) */
  matched: number;
  /** 金額乖離検出件数 (= recordError 済、DB は触らない) */
  drifted: number;
  /** Stripe 側で Invoice が見つからなかった件数 */
  invoiceNotFound: number;
  /** 照合 / API 失敗 */
  errors: Array<{ billingHistoryId: string; error: string }>;
  skippedStripeDisabled?: true;
};

/**
 * credit_card 払いの BillingHistory レコードと Stripe Invoice の金額を照合する。
 *
 * - 対象: 直近 monthsBack ヶ月分 (default 3) で stripeInvoiceId != null かつ status IN (paid, pending, failed)
 * - 照合: subtotal / tax / total が ±AMOUNT_RECONCILE_TOLERANCE_JPY 以内なら一致
 * - 乖離検出時: recordError で運用通知 (= DB は触らない、人間の判断で対応)
 * - replaced_by_stripe / refunded / canceled は対象外 (= 既に最終状態)
 *
 * 監査 C-G2 (S 優先度) の照合機能。月初 cron (= 既存 stripe-reconcile cron と同タイミング) で
 * 連続実行可能。
 */
export async function reconcileBillingHistoryAmounts(
  monthsBack: number = 3,
): Promise<AmountReconcileResult> {
  if (!isStripeEnabled()) {
    return {
      candidates: 0,
      matched: 0,
      drifted: 0,
      invoiceNotFound: 0,
      errors: [],
      skippedStripeDisabled: true,
    };
  }

  // 「直近 N ヶ月」の起点 = 現在時刻 - N ヶ月の月初
  const now = new Date();
  const startDate = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsBack, 1),
  );

  const targets = await prisma.billingHistory.findMany({
    where: {
      paymentMethod: 'credit_card',
      stripeInvoiceId: { not: null },
      status: { in: ['paid', 'pending', 'failed'] },
      createdAt: { gte: startDate },
    },
    select: {
      id: true,
      tenantId: true,
      stripeInvoiceId: true,
      amountJpy: true,
      taxAmountJpy: true,
      totalAmountJpy: true,
      yearMonth: true,
    },
  });

  const stripe = getStripe();
  let matched = 0;
  let drifted = 0;
  let invoiceNotFound = 0;
  const errors: AmountReconcileResult['errors'] = [];

  for (const b of targets) {
    if (b.stripeInvoiceId == null) continue;
    try {
      const result = await withStripeError<Stripe.Invoice>(() =>
        stripe.invoices.retrieve(b.stripeInvoiceId!),
      );
      if (!result.ok) {
        if (
          result.code === 'invalid_request'
          && /no such invoice/i.test(result.detail)
        ) {
          invoiceNotFound++;
          await recordError({
            severity: 'warn',
            source: 'cron',
            message: `Stripe Invoice not found for billing_history=${b.id}`,
            context: { kind: 'amount_reconcile', billingHistoryId: b.id, stripeInvoiceId: b.stripeInvoiceId },
          });
          continue;
        }
        errors.push({ billingHistoryId: b.id, error: `${result.code}: ${result.userMessage}` });
        continue;
      }

      const inv = result.value;
      const stripeSubtotal = inv.subtotal ?? 0;
      const stripeTax = inv.tax ?? 0;
      const stripeTotal = inv.total ?? 0;

      const subtotalDiff = Math.abs(stripeSubtotal - b.amountJpy);
      const taxDiff = Math.abs(stripeTax - b.taxAmountJpy);
      const totalDiff = Math.abs(stripeTotal - b.totalAmountJpy);

      const isMatched
        = subtotalDiff <= AMOUNT_RECONCILE_TOLERANCE_JPY
        && taxDiff <= AMOUNT_RECONCILE_TOLERANCE_JPY
        && totalDiff <= AMOUNT_RECONCILE_TOLERANCE_JPY;

      if (isMatched) {
        matched++;
      } else {
        drifted++;
        await recordError({
          severity: 'error',
          source: 'cron',
          message: `Billing amount drift detected: tenant=${b.tenantId} ym=${b.yearMonth}`,
          context: {
            kind: 'amount_reconcile_drift',
            billingHistoryId: b.id,
            tenantId: b.tenantId,
            yearMonth: b.yearMonth,
            stripe: { subtotal: stripeSubtotal, tax: stripeTax, total: stripeTotal },
            db: { subtotal: b.amountJpy, tax: b.taxAmountJpy, total: b.totalAmountJpy },
            diff: { subtotal: subtotalDiff, tax: taxDiff, total: totalDiff },
          },
        });
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      errors.push({ billingHistoryId: b.id, error: message });
    }
  }

  return {
    candidates: targets.length,
    matched,
    drifted,
    invoiceNotFound,
    errors,
  };
}
