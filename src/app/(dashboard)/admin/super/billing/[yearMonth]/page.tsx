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
import { getMonthlyBillingDetail } from '@/services/billing-dashboard.service';
import { ConfirmPaymentButton } from './confirm-payment-button';

const STRIPE_DASHBOARD_BASE = 'https://dashboard.stripe.com';
const VALID_YEAR_MONTH = /^\d{4}-\d{2}$/;

const STATUS_OPTIONS = [
  { value: '', label: '全て' },
  { value: 'pending', label: '入金待ち (pending)' },
  { value: 'paid', label: '入金確認済 (paid)' },
  { value: 'failed', label: '引落失敗 (failed)' },
  { value: 'refunded', label: '返金済 (refunded)' },
  { value: 'canceled', label: '取消 (canceled)' },
  { value: 'replaced_by_stripe', label: 'Stripe 一括置換 (replaced_by_stripe)' },
] as const;

const PAYMENT_METHOD_OPTIONS = [
  { value: '', label: '全て' },
  { value: 'credit_card', label: '💳 クレジットカード' },
  { value: 'invoice', label: '📋 請求書 / 銀行振込' },
] as const;

export default async function BillingDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ yearMonth: string }>;
  searchParams: Promise<{ status?: string; paymentMethod?: string }>;
}) {
  const { yearMonth } = await params;
  const { status, paymentMethod } = await searchParams;

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
          ← サマリへ戻る
        </Link>
      </nav>

      <h1 className="text-xl font-semibold">
        請求詳細: <span className="font-mono">{yearMonth}</span>
      </h1>

      {/* フィルタ (= GET form でクエリ string 反映) */}
      <form method="get" className="flex flex-wrap items-end gap-3 rounded-md border p-3">
        <FilterSelect
          label="ステータス"
          name="status"
          value={status ?? ''}
          options={STATUS_OPTIONS}
        />
        <FilterSelect
          label="支払方法"
          name="paymentMethod"
          value={paymentMethod ?? ''}
          options={PAYMENT_METHOD_OPTIONS}
        />
        <button
          type="submit"
          className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground"
        >
          絞り込み
        </button>
        <Link
          href={`/admin/super/billing/${yearMonth}`}
          className="text-xs text-muted-foreground underline-offset-2 hover:underline"
        >
          フィルタクリア
        </Link>
      </form>

      <div className="rounded-md border bg-muted/30 p-3 text-sm">
        絞り込み結果: <strong>{records.length} 件</strong> /{' '}
        合計 (税込): <strong className="tabular-nums">{formatYen(totalAmount)}</strong>
      </div>

      {/* 明細テーブル */}
      {records.length === 0 ? (
        <p className="rounded-md border p-4 text-sm text-muted-foreground">
          該当する請求履歴がありません。
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="bg-muted">
              <tr>
                <th className="px-3 py-2 text-left">テナント</th>
                <th className="px-3 py-2 text-left">支払方法</th>
                <th className="px-3 py-2 text-right">金額 (税込)</th>
                <th className="px-3 py-2 text-left">ステータス</th>
                <th className="px-3 py-2 text-left">入金日</th>
                <th className="px-3 py-2 text-left">失敗理由</th>
                <th className="px-3 py-2 text-left">アクション</th>
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
                          解約済
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
                      <code className="text-destructive">{r.failureReason}</code>
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
  if (method === 'bank_transfer') return '🏦 bank_transfer (旧)';
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
