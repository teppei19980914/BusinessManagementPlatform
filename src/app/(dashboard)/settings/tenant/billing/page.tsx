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

import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { LOGIN_ROUTE } from '@/config';
import { isTenantAdmin } from '@/lib/permissions';
import { getTenantBillingHistory } from '@/services/billing-management.service';

const RECENT_MONTHS = 6;

export default async function TenantBillingPage() {
  const session = await auth();
  if (!session?.user) {
    redirect(LOGIN_ROUTE);
  }
  if (!isTenantAdmin(session.user)) {
    redirect('/');
  }

  const t = await getTranslations('tenantSettings');
  const records = await getTenantBillingHistory(session.user.tenantId, RECENT_MONTHS);

  return (
    <div className="space-y-6 p-6">
      <nav className="text-sm">
        <Link href="/settings/tenant" className="text-info hover:underline">
          {t('billingBackLink')}
        </Link>
      </nav>

      <h1 className="text-xl font-semibold">{t('billingTitle')}</h1>
      <p className="text-sm text-muted-foreground">
        {t('billingDescription', { months: RECENT_MONTHS })}
      </p>

      {records.length === 0 ? (
        <p className="rounded-md border p-4 text-sm text-muted-foreground">
          {t('billingEmpty')}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="bg-muted">
              <tr>
                <th className="px-3 py-2 text-left">{t('billingColMonth')}</th>
                <th className="px-3 py-2 text-left">{t('billingColPaymentMethod')}</th>
                <th className="px-3 py-2 text-right">{t('billingColAmountExcl')}</th>
                <th className="px-3 py-2 text-right">{t('billingColTax')}</th>
                <th className="px-3 py-2 text-right">{t('billingColAmountIncl')}</th>
                <th className="px-3 py-2 text-left">{t('billingColStatus')}</th>
                <th className="px-3 py-2 text-left">{t('billingColPaidOrDue')}</th>
              </tr>
            </thead>
            <tbody>
              {records.map((r) => (
                <tr key={r.id} className={`border-t ${rowToneClass(r.status)}`}>
                  <td className="px-3 py-2 font-mono text-xs">{r.yearMonth}</td>
                  <td className="px-3 py-2 text-xs">{formatPaymentMethod(r.paymentMethod, t)}</td>
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
                    <StatusBadge status={r.status} retryCount={0} failureReason={r.failureReason} t={t} />
                  </td>
                  <td className="px-3 py-2 text-xs whitespace-nowrap">
                    {r.paidAt ? (
                      <span className="text-success">
                        {t('billingPaidPrefix', { date: formatDate(r.paidAt) })}
                      </span>
                    ) : r.paymentDueDate ? (
                      <span className="text-muted-foreground">
                        {t('billingDuePrefix', { date: formatDate(r.paymentDueDate) })}
                      </span>
                    ) : r.nextPaymentAttempt ? (
                      <span className="text-destructive">
                        {t('billingNextChargePrefix', { date: formatDate(r.nextPaymentAttempt) })}
                      </span>
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
        <p>
          ⓘ {t.rich('billingCcGuide', { strong: (chunks) => <strong>{chunks}</strong> })}
        </p>
        <p className="mt-1">
          ⓘ {t.rich('billingBankGuideStart', { strong: (chunks) => <strong>{chunks}</strong> })}
          <code className="rounded bg-background px-1">{t('billingBankGuideEmailCode')}</code>
          {t('billingBankGuideEnd')}
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

function formatPaymentMethod(method: string, t: (key: string) => string): string {
  if (method === 'credit_card') return t('billingMethodCreditCard');
  if (method === 'invoice') return t('billingMethodInvoice');
  if (method === 'bank_transfer') return t('billingMethodBankTransferLegacy');
  return method;
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

function StatusBadge({
  status,
  retryCount: _retryCount,
  failureReason,
  t,
}: {
  status: string;
  retryCount: number;
  failureReason: string | null;
  t: (key: string, params?: Record<string, string | number>) => string;
}) {
  type Spec = { label: string; className: string };
  const map: Record<string, Spec> = {
    paid: { label: t('billingStatusPaid'), className: 'bg-success/20 text-success' },
    pending: { label: t('billingStatusPending'), className: 'bg-info/20 text-info' },
    failed: {
      label: failureReason
        ? t('billingStatusFailedWithReason', { reason: failureReason })
        : t('billingStatusFailed'),
      className: 'bg-destructive/20 text-destructive',
    },
    refunded: { label: t('billingStatusRefunded'), className: 'bg-muted' },
    canceled: { label: t('billingStatusCanceled'), className: 'bg-muted text-muted-foreground' },
    replaced_by_stripe: {
      label: t('billingStatusReplacedByStripe'),
      className: 'bg-muted text-muted-foreground',
    },
  };
  const v = map[status] ?? { label: status, className: 'bg-muted' };
  return (
    <span className={`rounded-md px-2 py-0.5 text-xs font-medium ${v.className}`}>
      {v.label}
    </span>
  );
}
