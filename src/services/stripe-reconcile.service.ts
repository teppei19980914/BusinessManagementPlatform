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
