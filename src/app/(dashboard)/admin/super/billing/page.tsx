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
import { getBillingSummary, getRecentMonths } from '@/services/billing-dashboard.service';

const RECENT_MONTHS_COUNT = 6;

export default async function BillingDashboardPage() {
  const months = getRecentMonths(RECENT_MONTHS_COUNT);
  const summaries = await getBillingSummary(months);
  const currentMonth = summaries[0];

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">請求ダッシュボード</h1>
      <p className="text-sm text-muted-foreground">
        テナント別の月次請求ステータス・引落結果・売上集計を確認できます。
        データソースは <code className="rounded bg-muted px-1">BillingHistory</code>{' '}
        テーブル (= Stripe Webhook 経由で自動更新)。
      </p>

      {/* 当月サマリ */}
      {currentMonth && (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold">
            当月 ({currentMonth.yearMonth}) サマリ
          </h2>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            <SummaryCard
              label="請求総額 (税込)"
              value={formatYen(currentMonth.totalAmount)}
              tone="neutral"
            />
            <SummaryCard
              label="入金確認済"
              value={formatYen(currentMonth.paidAmount)}
              subValue={`${currentMonth.countByStatus.paid ?? 0} 件`}
              tone="success"
            />
            <SummaryCard
              label="入金待ち"
              value={formatYen(currentMonth.pendingAmount)}
              subValue={`${currentMonth.countByStatus.pending ?? 0} 件`}
              tone="neutral"
            />
            <SummaryCard
              label="引落失敗"
              value={formatYen(currentMonth.failedAmount)}
              subValue={`${currentMonth.countByStatus.failed ?? 0} 件`}
              tone={(currentMonth.countByStatus.failed ?? 0) > 0 ? 'error' : 'neutral'}
            />
            <SummaryCard
              label="Stripe 一括置換済"
              value={formatYen(currentMonth.replacedAmount)}
              subValue={`${currentMonth.countByStatus.replaced_by_stripe ?? 0} 件`}
              tone="neutral"
            />
          </div>

          {/* 支払方法別内訳 */}
          <div className="rounded-md border p-3 text-sm">
            <h3 className="mb-2 font-semibold">支払方法別 (件数)</h3>
            <div className="flex flex-wrap gap-4 text-xs">
              <span>
                💳 クレジットカード:{' '}
                <strong>{currentMonth.countByPaymentMethod.credit_card ?? 0} 件</strong>
              </span>
              <span>
                📋 請求書 / 銀行振込:{' '}
                <strong>{currentMonth.countByPaymentMethod.invoice ?? 0} 件</strong>
              </span>
              {currentMonth.countByPaymentMethod.bank_transfer != null
                && currentMonth.countByPaymentMethod.bank_transfer > 0 && (
                  <span>
                    🏦 旧 bank_transfer:{' '}
                    <strong>{currentMonth.countByPaymentMethod.bank_transfer} 件</strong>
                  </span>
                )}
            </div>
          </div>

          <Link
            href={`/admin/super/billing/${currentMonth.yearMonth}`}
            className="inline-flex items-center text-sm text-info underline-offset-2 hover:underline"
          >
            → 当月の詳細を表示
          </Link>
        </section>
      )}

      {/* 過去 6 ヶ月推移 */}
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">直近 {RECENT_MONTHS_COUNT} ヶ月推移</h2>
        {summaries.length === 0 ? (
          <p className="text-sm text-muted-foreground">請求履歴がまだありません。</p>
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead className="bg-muted">
                <tr>
                  <th className="px-3 py-2 text-left">対象月</th>
                  <th className="px-3 py-2 text-right">請求総額</th>
                  <th className="px-3 py-2 text-right">入金確認済</th>
                  <th className="px-3 py-2 text-right">入金待ち</th>
                  <th className="px-3 py-2 text-right">引落失敗</th>
                  <th className="px-3 py-2 text-left">アクション</th>
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
                        詳細 →
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
