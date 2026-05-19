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

  const records = await getTenantBillingHistory(session.user.tenantId, RECENT_MONTHS);

  return (
    <div className="space-y-6 p-6">
      <nav className="text-sm">
        <Link href="/settings/tenant" className="text-info hover:underline">
          ← テナント設定へ戻る
        </Link>
      </nav>

      <h1 className="text-xl font-semibold">請求履歴</h1>
      <p className="text-sm text-muted-foreground">
        直近 {RECENT_MONTHS} ヶ月の請求履歴です。クレジットカード払いは Stripe 自動引落
        の結果が反映されます。銀行振込払いは入金確認後に status が「入金確認済」に
        切り替わります。
      </p>

      {records.length === 0 ? (
        <p className="rounded-md border p-4 text-sm text-muted-foreground">
          請求履歴がまだありません。
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="bg-muted">
              <tr>
                <th className="px-3 py-2 text-left">対象月</th>
                <th className="px-3 py-2 text-left">支払方法</th>
                <th className="px-3 py-2 text-right">金額 (税抜)</th>
                <th className="px-3 py-2 text-right">消費税</th>
                <th className="px-3 py-2 text-right">合計 (税込)</th>
                <th className="px-3 py-2 text-left">ステータス</th>
                <th className="px-3 py-2 text-left">入金日 / 支払期日</th>
              </tr>
            </thead>
            <tbody>
              {records.map((r) => (
                <tr key={r.id} className={`border-t ${rowToneClass(r.status)}`}>
                  <td className="px-3 py-2 font-mono text-xs">{r.yearMonth}</td>
                  <td className="px-3 py-2 text-xs">{formatPaymentMethod(r.paymentMethod)}</td>
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
                    <StatusBadge status={r.status} retryCount={0} failureReason={r.failureReason} />
                  </td>
                  <td className="px-3 py-2 text-xs whitespace-nowrap">
                    {r.paidAt ? (
                      <span className="text-success">
                        入金 {formatDate(r.paidAt)}
                      </span>
                    ) : r.paymentDueDate ? (
                      <span className="text-muted-foreground">
                        期日 {formatDate(r.paymentDueDate)}
                      </span>
                    ) : r.nextPaymentAttempt ? (
                      <span className="text-destructive">
                        次回引落 {formatDate(r.nextPaymentAttempt)}
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
          ⓘ <strong>クレジットカード払い</strong>: 月末締めの翌日に Stripe で自動引落。
          失敗時は Smart Retries (2 週間で最大 8 回) で自動再試行されます。
        </p>
        <p className="mt-1">
          ⓘ <strong>銀行振込</strong>: 月末締め、翌月 25 日までにお振込ください。
          請求書 PDF は <code className="rounded bg-background px-1">請求担当者メール</code> 宛にお送りします。
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

function formatPaymentMethod(method: string): string {
  if (method === 'credit_card') return '💳 クレジットカード';
  if (method === 'invoice') return '📋 銀行振込';
  if (method === 'bank_transfer') return '🏦 銀行振込 (旧)';
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
}: {
  status: string;
  retryCount: number;
  failureReason: string | null;
}) {
  const map: Record<string, { label: string; className: string }> = {
    paid: { label: '✓ 入金確認済', className: 'bg-success/20 text-success' },
    pending: { label: '⋯ 入金待ち', className: 'bg-info/20 text-info' },
    failed: {
      label: `✗ 引落失敗${failureReason ? ` (${failureReason})` : ''}`,
      className: 'bg-destructive/20 text-destructive',
    },
    refunded: { label: '↩ 返金済', className: 'bg-muted' },
    canceled: { label: '— 取消', className: 'bg-muted text-muted-foreground' },
    replaced_by_stripe: {
      label: '↪ Stripe 一括請求に置換',
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
