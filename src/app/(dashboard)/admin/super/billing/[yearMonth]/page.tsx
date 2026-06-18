/**
 * /admin/super/billing/[yearMonth] (PR-V7 #8 / 2026-05-19)
 *
 * super_admin 向け請求ダッシュボード月次詳細画面。
 * - 指定月のテナント別 BillingHistory レコード一覧
 * - status / paymentMethod のクエリ string フィルタ
 * - credit_card の行に Stripe Dashboard へのディープリンク
 *
 * 認可: layout.tsx (super_admin guard) + middleware Basic Auth で多層防御済。
 *
 * URL 例:
 *   /admin/super/billing/2026-06                    (= 全レコード)
 *   /admin/super/billing/2026-06?status=failed      (= 失敗のみ)
 *   /admin/super/billing/2026-06?paymentMethod=credit_card  (= カード払いのみ)
 */

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getMonthlyBillingDetail } from '@/services/billing-dashboard.service';
import { ConfirmPaymentButton } from './confirm-payment-button';

const STRIPE_DASHBOARD_BASE = 'https://dashboard.stripe.com';
const VALID_YEAR_MONTH = /^\d{4}-\d{2}$/;

const STATUS_OPTION_KEYS = [
  { value: '', key: 'billingFilterAll' },
  { value: 'pending', key: 'billingFilterStatusPending' },
  { value: 'paid', key: 'billingFilterStatusPaid' },
  { value: 'failed', key: 'billingFilterStatusFailed' },
  { value: 'refunded', key: 'billingFilterStatusRefunded' },
  { value: 'canceled', key: 'billingFilterStatusCanceled' },
  { value: 'replaced_by_stripe', key: 'billingFilterStatusReplaced' },
] as const;

const PAYMENT_METHOD_OPTION_KEYS = [
  { value: '', key: 'billingFilterAll' },
  { value: 'credit_card', key: 'billingMethodCreditCard' },
  { value: 'invoice', key: 'billingMethodInvoice' },
] as const;

export default async function BillingDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ yearMonth: string }>;
  searchParams: Promise<{ status?: string; paymentMethod?: string }>;
}) {
  const t = await getTranslations('superAdmin');
  const { yearMonth } = await params;
  const { status, paymentMethod } = await searchParams;
  const statusOptions = STATUS_OPTION_KEYS.map((o) => ({ value: o.value, label: t(o.key) }));
  const paymentMethodOptions = PAYMENT_METHOD_OPTION_KEYS.map((o) => ({
    value: o.value,
    label: o.value === '' ? t(o.key) : t(o.key).replace(/:\s*$/, ''),
  }));

  // YYYY-MM 形式バリデーション (= /YYYY-MM/ 以外のパスは 404)
  if (!VALID_YEAR_MONTH.test(yearMonth)) {
    notFound();
  }

  const records = await getMonthlyBillingDetail(yearMonth, {
    status: status || undefined,
    paymentMethod: paymentMethod || undefined,
  });

  const totalAmount = records.reduce((sum, r) => sum + r.totalAmountJpy, 0);

  return (
    <div className="space-y-4">
      <nav className="text-sm">
        <Link href="/admin/super/billing" className="text-info hover:underline">
          {t('billingDetailBackToSummary')}
        </Link>
      </nav>

      <div className="flex items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">
          {t('billingDetailTitle')}<span className="font-mono">{yearMonth}</span>
        </h1>
        {/* PR-V7a (C-5): CSV エクスポート (= Next.js dynamic slug 衝突回避で export/[yearMonth] 形式) */}
        <a
          href={`/api/admin/super/billing/export/${yearMonth}${
            status || paymentMethod
              ? `?${new URLSearchParams({
                  ...(status ? { status } : {}),
                  ...(paymentMethod ? { paymentMethod } : {}),
                }).toString()}`
              : ''
          }`}
          download
          className="rounded-md border border-input bg-background px-3 py-1 text-xs font-medium hover:bg-accent"
        >
          {t('billingDetailCsvExport')}
        </a>
      </div>

      {/* フィルタ (= GET form でクエリ string 反映) */}
      <form method="get" className="flex flex-wrap items-end gap-3 rounded-md border p-3">
        <FilterSelect
          label={t('billingDetailFilterStatus')}
          name="status"
          value={status ?? ''}
          options={statusOptions}
        />
        <FilterSelect
          label={t('billingDetailFilterPaymentMethod')}
          name="paymentMethod"
          value={paymentMethod ?? ''}
          options={paymentMethodOptions}
        />
        <button
          type="submit"
          className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground"
        >
          {t('billingDetailFilterApply')}
        </button>
        <Link
          href={`/admin/super/billing/${yearMonth}`}
          className="text-xs text-muted-foreground underline-offset-2 hover:underline"
        >
          {t('billingDetailFilterClear')}
        </Link>
      </form>

      <div className="rounded-md border bg-muted/30 p-3 text-sm">
        {t('billingDetailResultsPrefix')}
        {t.rich('billingDetailResultsCount', { count: records.length, strong: (chunks) => <strong>{chunks}</strong> })}
        {t('billingDetailTotalPrefix')}
        <strong className="tabular-nums">{formatYen(totalAmount)}</strong>
      </div>

      {/* 明細テーブル */}
      {records.length === 0 ? (
        <p className="rounded-md border p-4 text-sm text-muted-foreground">
          {t('billingDetailEmpty')}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="bg-muted">
              <tr>
                <th className="px-3 py-2 text-left">{t('billingDetailColTenant')}</th>
                <th className="px-3 py-2 text-left">{t('billingDetailColPaymentMethod')}</th>
                <th className="px-3 py-2 text-right">{t('billingDetailColAmountIncl')}</th>
                <th className="px-3 py-2 text-left">{t('billingDetailColStatus')}</th>
                <th className="px-3 py-2 text-left">{t('billingDetailColPaidAt')}</th>
                <th className="px-3 py-2 text-left">{t('billingDetailColFailReason')}</th>
                <th className="px-3 py-2 text-left">{t('billingDetailColActions')}</th>
              </tr>
            </thead>
            <tbody>
              {records.map((r) => (
                <tr key={r.id} className={`border-t ${getRowToneClass(r.status)}`}>
                  <td className="px-3 py-2">
                    <div className="text-xs font-medium">
                      {r.tenantName}
                      {r.tenantDeletedAt != null && (
                        <span className="ml-1 rounded bg-destructive/20 px-1 text-[10px] text-destructive">
                          {t('billingDetailTenantTerminated')}
                        </span>
                      )}
                    </div>
                    {r.tenantSeq != null && (
                      <div className="text-[10px] text-muted-foreground">
                        #{r.tenantSeq}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs">{formatPaymentMethod(r.paymentMethod)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatYen(r.totalAmountJpy)}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    <StatusBadge status={r.status} retryCount={r.retryCount} />
                  </td>
                  <td className="px-3 py-2 text-xs whitespace-nowrap">
                    {r.paidAt ? formatDateTime(r.paidAt) : '—'}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {r.failureReason ? (
                      <div className="space-y-0.5">
                        <code className="text-destructive">{r.failureReason}</code>
                        {/* PR-V7a (C-1): Smart Retries 次回試行日表示 */}
                        {r.nextPaymentAttempt && r.status === 'failed' && (
                          <div className="text-[10px] text-muted-foreground">
                            {t('billingDetailNextRetryPrefix')}{formatDateTime(r.nextPaymentAttempt)}
                          </div>
                        )}
                        {!r.nextPaymentAttempt && r.status === 'failed' && r.retryCount > 0 && (
                          <div className="text-[10px] text-destructive">
                            {t('billingDetailRetryExhausted')}
                          </div>
                        )}
                      </div>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    <div className="flex items-center gap-2">
                      {/* credit_card: Stripe Dashboard ディープリンク */}
                      {r.stripeInvoiceId && (
                        <a
                          href={`${STRIPE_DASHBOARD_BASE}/invoices/${r.stripeInvoiceId}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-info underline-offset-2 hover:underline"
                        >
                          Stripe ↗
                        </a>
                      )}
                      {/* invoice/bank_transfer + pending: 手動消込ボタン (PR-V7a) */}
                      {r.status === 'pending'
                        && (r.paymentMethod === 'invoice'
                          || r.paymentMethod === 'bank_transfer') && (
                        <ConfirmPaymentButton
                          billingHistoryId={r.id}
                          tenantName={r.tenantName}
                        />
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function FilterSelect({
  label,
  name,
  value,
  options,
}: {
  label: string;
  name: string;
  value: string;
  options: ReadonlyArray<{ value: string; label: string }>;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <select
        name={name}
        defaultValue={value}
        className="rounded border bg-background px-2 py-1 text-xs"
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function StatusBadge({ status, retryCount }: { status: string; retryCount: number }) {
  const map: Record<string, { label: string; className: string }> = {
    paid: { label: '✓ paid', className: 'bg-success/20 text-success' },
    pending: { label: '⋯ pending', className: 'bg-info/20 text-info' },
    failed: {
      label: `✗ failed${retryCount > 0 ? ` (retry ${retryCount})` : ''}`,
      className: 'bg-destructive/20 text-destructive',
    },
    refunded: { label: '↩ refunded', className: 'bg-muted text-foreground' },
    canceled: { label: '— canceled', className: 'bg-muted text-muted-foreground' },
    replaced_by_stripe: {
      label: '↪ replaced',
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

function getRowToneClass(status: string): string {
  if (status === 'failed') return 'bg-destructive/5';
  return '';
}

function formatPaymentMethod(method: string): string {
  if (method === 'credit_card') return '💳 credit_card';
  if (method === 'invoice') return '📋 invoice';
  if (method === 'bank_transfer') return '🏦 bank_transfer (legacy)';
  return method;
}

function formatYen(amount: number): string {
  return `¥${amount.toLocaleString('ja-JP')}`;
}

function formatDateTime(d: Date): string {
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d);
}
