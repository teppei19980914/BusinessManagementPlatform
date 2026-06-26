/**
 * /admin/super/billing (PR-V7 #8 / 2026-05-19)
 *
 * super_admin 向け請求ダッシュボードのサマリ画面。
 * - 当月サマリ (= 請求総額 / 入金済 / 入金待ち / 失敗)
 * - 支払方法別の内訳件数
 * - 過去 6 ヶ月の月次推移 (= 各月の詳細画面へのリンク付き)
 *
 * 認可: layout.tsx (super_admin guard) + middleware Basic Auth (= PR-V7 #7) で多層防御済。
 *
 * データ取得: server component で billing-dashboard.service 直接呼出 (= API ルート経由不要)。
 */

import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { getBillingSummary, getRecentMonths } from '@/services/billing-dashboard.service';

const RECENT_MONTHS_COUNT = 6;

export default async function BillingDashboardPage() {
  const t = await getTranslations('adminBilling');
  const months = getRecentMonths(RECENT_MONTHS_COUNT);
  const summaries = await getBillingSummary(months);
  const currentMonth = summaries[0];

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">{t('dashboardTitle')}</h1>
      <p className="text-sm text-muted-foreground">
        {t('dashboardDescPre')}
        <code className="rounded bg-muted px-1">BillingHistory</code>{' '}
        {t('dashboardDescSuffix')}
      </p>

      {/* 当月サマリ */}
      {currentMonth && (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold">
            {t('currentMonthHeading', { month: currentMonth.yearMonth })}
          </h2>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            <SummaryCard
              label={t('cardTotalAmount')}
              value={formatYen(currentMonth.totalAmount)}
              tone="neutral"
            />
            <SummaryCard
              label={t('cardPaid')}
              value={formatYen(currentMonth.paidAmount)}
              subValue={t('countItems', { count: currentMonth.countByStatus.paid ?? 0 })}
              tone="success"
            />
            <SummaryCard
              label={t('cardPending')}
              value={formatYen(currentMonth.pendingAmount)}
              subValue={t('countItems', { count: currentMonth.countByStatus.pending ?? 0 })}
              tone="neutral"
            />
            <SummaryCard
              label={t('cardFailed')}
              value={formatYen(currentMonth.failedAmount)}
              subValue={t('countItems', { count: currentMonth.countByStatus.failed ?? 0 })}
              tone={(currentMonth.countByStatus.failed ?? 0) > 0 ? 'error' : 'neutral'}
            />
            <SummaryCard
              label={t('cardReplaced')}
              value={formatYen(currentMonth.replacedAmount)}
              subValue={t('countItems', { count: currentMonth.countByStatus.replaced_by_stripe ?? 0 })}
              tone="neutral"
            />
          </div>

          {/* 支払方法別内訳 */}
          <div className="rounded-md border p-3 text-sm">
            <h3 className="mb-2 font-semibold">{t('payMethodBreakdownTitle')}</h3>
            <div className="flex flex-wrap gap-4 text-xs">
              <span>
                {t('payMethodCreditCard')}{' '}
                <strong>{t('countItems', { count: currentMonth.countByPaymentMethod.credit_card ?? 0 })}</strong>
              </span>
              <span>
                {t('payMethodInvoice')}{' '}
                <strong>{t('countItems', { count: currentMonth.countByPaymentMethod.invoice ?? 0 })}</strong>
              </span>
              {currentMonth.countByPaymentMethod.bank_transfer != null
                && currentMonth.countByPaymentMethod.bank_transfer > 0 && (
                  <span>
                    {t('payMethodBankTransferOld')}{' '}
                    <strong>{t('countItems', { count: currentMonth.countByPaymentMethod.bank_transfer })}</strong>
                  </span>
                )}
            </div>
          </div>

          <Link
            href={`/admin/super/billing/${currentMonth.yearMonth}`}
            className="inline-flex items-center text-sm text-info underline-offset-2 hover:underline"
          >
            {t('linkCurrentMonthDetail')}
          </Link>
        </section>
      )}

      {/* 過去 6 ヶ月推移 */}
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">{t('recentMonthsHeading', { months: RECENT_MONTHS_COUNT })}</h2>
        {summaries.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('noHistory')}</p>
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead className="bg-muted">
                <tr>
                  <th className="px-3 py-2 text-left">{t('colMonth')}</th>
                  <th className="px-3 py-2 text-right">{t('colTotalAmount')}</th>
                  <th className="px-3 py-2 text-right">{t('colPaidAmount')}</th>
                  <th className="px-3 py-2 text-right">{t('colPendingAmount')}</th>
                  <th className="px-3 py-2 text-right">{t('colFailedAmount')}</th>
                  <th className="px-3 py-2 text-left">{t('colAction')}</th>
                </tr>
              </thead>
              <tbody>
                {summaries.map((s) => (
                  <tr key={s.yearMonth} className="border-t">
                    <td className="px-3 py-2 font-mono text-xs">{s.yearMonth}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatYen(s.totalAmount)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-success">
                      {formatYen(s.paidAmount)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatYen(s.pendingAmount)}
                    </td>
                    <td
                      className={`px-3 py-2 text-right tabular-nums ${
                        s.failedAmount > 0 ? 'text-destructive font-semibold' : ''
                      }`}
                    >
                      {formatYen(s.failedAmount)}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      <Link
                        href={`/admin/super/billing/${s.yearMonth}`}
                        className="text-info underline-offset-2 hover:underline"
                      >
                        {t('linkDetail')}
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function SummaryCard({
  label,
  value,
  subValue,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  subValue?: string;
  tone?: 'success' | 'error' | 'neutral';
}) {
  const toneClass
    = tone === 'success'
      ? 'border-success/30 bg-success/5'
      : tone === 'error'
        ? 'border-destructive/30 bg-destructive/5'
        : 'border-input';
  return (
    <div className={`rounded-md border p-3 ${toneClass}`}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-xl font-semibold tabular-nums">{value}</div>
      {subValue && <div className="mt-0.5 text-xs text-muted-foreground">{subValue}</div>}
    </div>
  );
}

function formatYen(amount: number): string {
  return `¥${amount.toLocaleString('ja-JP')}`;
}
