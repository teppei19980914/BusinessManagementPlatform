/**
 * /settings/tenant/billing (PR-V7a / 2026-05-19)
 *
 * テナント管理者 (= 顧客) 向け請求金額表示画面 (= 監査 C-G6 解消)。
 * 自テナントの直近 6 ヶ月の BillingHistory を一覧表示し、当月の請求予定 + 支払期日を可視化。
 *
 * 認可: テナント管理者 (admin) のみ。super_admin / general はリダイレクト。
 *
 * 関連:
 *   - サービス: src/services/billing-management.service.ts getTenantBillingHistory
 *   - 支払方法切替: /settings/tenant の stripe-payment-method-section
 */

import { getTranslations } from 'next-intl/server';
import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { LOGIN_ROUTE } from '@/config';
import { isTenantAdmin } from '@/lib/permissions';
import { getTenantBillingHistory } from '@/services/billing-management.service';

const RECENT_MONTHS = 6;

export default async function TenantBillingPage() {
  const t = await getTranslations('tenantBilling');
  const session = await auth();
  if (!session?.user) {
    redirect(LOGIN_ROUTE);
  }
  if (!isTenantAdmin(session.user)) {
    redirect('/');
  }

  const records = await getTenantBillingHistory(session.user.tenantId, RECENT_MONTHS);

  const formatPaymentMethodLabel = (method: string): string => {
    if (method === 'credit_card') return t('payMethodCreditCard');
    if (method === 'invoice') return t('payMethodInvoice');
    if (method === 'bank_transfer') return t('payMethodBankTransfer');
    return method;
  };

  const statusMap: Record<string, { label: string; className: string }> = {
    paid: { label: t('statusPaid'), className: 'bg-success/20 text-success' },
    pending: { label: t('statusPending'), className: 'bg-info/20 text-info' },
    failed: { label: t('statusFailed'), className: 'bg-destructive/20 text-destructive' },
    refunded: { label: t('statusRefunded'), className: 'bg-muted' },
    canceled: { label: t('statusCanceled'), className: 'bg-muted text-muted-foreground' },
    replaced_by_stripe: { label: t('statusReplacedByStripe'), className: 'bg-muted text-muted-foreground' },
  };

  return (
    <div className="space-y-6 p-6">
      <nav className="text-sm">
        <Link href="/settings/tenant" className="text-info hover:underline">
          {t('backLink')}
        </Link>
      </nav>

      <h1 className="text-xl font-semibold">{t('pageTitle')}</h1>
      <p className="text-sm text-muted-foreground">
        {t('description', { months: RECENT_MONTHS })}
      </p>

      {records.length === 0 ? (
        <p className="rounded-md border p-4 text-sm text-muted-foreground">
          {t('emptyState')}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="bg-muted">
              <tr>
                <th className="px-3 py-2 text-left">{t('colMonth')}</th>
                <th className="px-3 py-2 text-left">{t('colPayMethod')}</th>
                <th className="px-3 py-2 text-right">{t('colAmount')}</th>
                <th className="px-3 py-2 text-right">{t('colTax')}</th>
                <th className="px-3 py-2 text-right">{t('colTotal')}</th>
                <th className="px-3 py-2 text-left">{t('colStatus')}</th>
                <th className="px-3 py-2 text-left">{t('colPayDate')}</th>
              </tr>
            </thead>
            <tbody>
              {records.map((r) => {
                const sv = statusMap[r.status] ?? { label: r.status, className: 'bg-muted' };
                const statusLabel = r.status === 'failed' && r.failureReason
                  ? `${sv.label} (${r.failureReason})`
                  : sv.label;
                return (
                  <tr key={r.id} className={`border-t ${rowToneClass(r.status)}`}>
                    <td className="px-3 py-2 font-mono text-xs">{r.yearMonth}</td>
                    <td className="px-3 py-2 text-xs">{formatPaymentMethodLabel(r.paymentMethod)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatYen(r.amountJpy)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatYen(r.taxAmountJpy)}
                    </td>
                    <td className="px-3 py-2 text-right font-semibold tabular-nums">
                      {formatYen(r.totalAmountJpy)}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      <span className={`rounded-md px-2 py-0.5 text-xs font-medium ${sv.className}`}>
                        {statusLabel}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-xs whitespace-nowrap">
                      {r.paidAt ? (
                        <span className="text-success">
                          {t('paidAt', { date: formatDate(r.paidAt) })}
                        </span>
                      ) : r.paymentDueDate ? (
                        <span className="text-muted-foreground">
                          {t('dueDate', { date: formatDate(r.paymentDueDate) })}
                        </span>
                      ) : r.nextPaymentAttempt ? (
                        <span className="text-destructive">
                          {t('nextAttempt', { date: formatDate(r.nextPaymentAttempt) })}
                        </span>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
        <p>
          ⓘ <strong>{t('notesCcTitle')}</strong>: {t('notesCcBody')}
        </p>
        <p className="mt-1">
          ⓘ <strong>{t('notesInvoiceTitle')}</strong>: {t('notesInvoiceBodyPrefix')}{' '}
          <code className="rounded bg-background px-1">{t('notesInvoiceBillingEmail')}</code>{' '}
          {t('notesInvoiceBodySuffix')}
        </p>
      </div>
    </div>
  );
}

function rowToneClass(status: string): string {
  if (status === 'failed') return 'bg-destructive/5';
  if (status === 'paid') return '';
  if (status === 'pending') return 'bg-info/5';
  return '';
}

function formatYen(amount: number): string {
  return `¥${amount.toLocaleString('ja-JP')}`;
}

function formatDate(d: Date): string {
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .format(d)
    .replace(/\//g, '-');
}
