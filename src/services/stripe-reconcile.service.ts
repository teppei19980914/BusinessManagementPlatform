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
 *   - schedule: 外部 cron (cron-job.org) `0 6 1 * *` (= 毎月 1 日 06:00 UTC = JST 15:00)
 */

import type Stripe from 'stripe';
import { prisma } from '@/lib/db';
import { isStripeEnabled, getStripe } from '@/lib/stripe';
import { withStripeError } from '@/lib/stripe-error-handler';
import { recordError } from './error-log.service';
// PR-V7a 穴 D/E 修正 (2026-05-19): 金額乖離 / API 失敗時に super_admin へ active push
import { sendSuperAdminAlert } from './admin-alert.service';

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

  // PR-V7a 穴 E 修正 (2026-05-19): errors.length > 0 を active push
  //   per-tenant の Stripe API 失敗が累積していると rate limit / 障害の兆候。
  //   従来は recordError 経由で system_error_logs に記録するのみ (= passive pull) だった。
  if (errors.length > 0) {
    const errorLines = errors
      .slice(0, 20)
      .map((e) => `- tenant ${e.tenantId}: ${e.error}`)
      .join('\n');
    const overflowSuffix = errors.length > 20 ? `\n... (他 ${errors.length - 20} 件)` : '';
    await sendSuperAdminAlert(
      `[たすきば] Stripe Subscription 照合で ${errors.length} 件のエラー (= API 障害の可能性)`,
      `月次 stripe-reconcile cron で per-tenant Stripe API 呼出が失敗しました。\n`
        + `合計 ${candidates.length} テナント中 ${errors.length} 件失敗 / ${matched} 件一致 / ${corrected} 件修正。\n\n`
        + `エラー詳細:\n${errorLines}${overflowSuffix}\n\n`
        + `対応: rate limit / 一時障害なら次回 cron で自動回復。`
        + `継続するなら Stripe API key の権限 / Stripe ステータスページ確認。`,
    );
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

  // PR-V7a 穴 D 修正 (2026-05-19): drifted > 0 を active push
  //   従来は乖離検出時 recordError で system_error_logs 記録のみ (= passive pull)。
  //   月初 1 回しか走らない cron なので、メール通知がないと最大 30 日放置リスク。
  if (drifted > 0) {
    await sendSuperAdminAlert(
      `[たすきば] Stripe ↔ DB 金額乖離 ${drifted} 件 (= 月次照合で検出)`,
      `Stripe Invoice と DB BillingHistory の金額が乖離しています。\n\n`
        + `照合対象: ${targets.length} 件 (直近 3 ヶ月の credit_card 請求)\n`
        + `一致: ${matched} 件 / 乖離: ${drifted} 件 / Invoice 不見当: ${invoiceNotFound} 件\n\n`
        + `対応:\n`
        + `1. /admin/super/cron-history で詳細 (error_log) を確認\n`
        + `2. lookup: system_error_logs WHERE context->>'kind' = 'amount_reconcile_drift'\n`
        + `3. Stripe Invoice 側を信頼源として手動で BillingHistory を補正、または逆\n`
        + `4. 原因究明: Usage Record 二重送信 / Stripe Tax 計算ロジック変更 / 月跨ぎ等を疑う`,
    );
  }
  if (invoiceNotFound > 0) {
    await sendSuperAdminAlert(
      `[たすきば] Stripe Invoice が見つからない件数 ${invoiceNotFound} 件`,
      `DB BillingHistory に stripeInvoiceId が記録されているが、Stripe 側で Invoice が見つかりません。\n`
        + `(= Stripe 側の手動削除 / アカウント切替 / Sandbox→Live 移行直後の典型)\n\n`
        + `照合対象: ${targets.length} / 不見当: ${invoiceNotFound}\n`
        + `対応: /admin/super/billing で該当 BillingHistory を特定、stripeInvoiceId クリア or 再設定`,
    );
  }

  return {
    candidates: targets.length,
    matched,
    drifted,
    invoiceNotFound,
    errors,
  };
}
