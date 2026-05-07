/**
 * /admin/super (super_admin ダッシュボードのトップ) (PR-X2 / 2026-05-07)
 *
 * 全テナント横断のサマリを表示。詳細はサブナビゲーションから。
 */

import { getCrossTenantUsageSummary } from '@/services/super-admin.service';

export default async function SuperAdminTopPage() {
  const summary = await getCrossTenantUsageSummary();

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">システム管理者ダッシュボード</h1>

      <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryCard label="顧客テナント数" value={summary.tenantCount.toString()} />
        <SummaryCard label="アクティブユーザ総数" value={summary.totalActiveUsers.toString()} />
        <SummaryCard
          label="今月の API 呼出 (合計)"
          value={summary.totalCurrentMonthApiCalls.toLocaleString()}
        />
        <SummaryCard
          label="今月の API 費用 (合計)"
          value={`¥${summary.totalCurrentMonthApiCostJpy.toLocaleString()}`}
        />
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">プラン別テナント数</h2>
        <ul className="rounded border p-3 text-sm">
          {summary.planDistribution.length === 0 ? (
            <li className="text-muted-foreground">テナントがありません</li>
          ) : (
            summary.planDistribution.map((p) => (
              <li key={p.plan} className="flex justify-between border-b py-1 last:border-b-0">
                <span className="font-medium capitalize">{p.plan}</span>
                <span>{p.count} 件</span>
              </li>
            ))
          )}
        </ul>
      </section>
    </div>
  );
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-bold">{value}</p>
    </div>
  );
}
