/**
 * /admin/super/usage (PR-X2 / 2026-05-07)
 *
 * 全テナント横断の使用量サマリ。詳細な数値表示 (グラフは Phase 2 で追加検討)。
 */

import { getCrossTenantUsageSummary } from '@/services/super-admin.service';

export default async function SuperAdminUsagePage() {
  const summary = await getCrossTenantUsageSummary();

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">使用量サマリ (全テナント横断)</h1>
      <p className="text-sm text-muted-foreground">
        管理テナント (運営内部) は集計から除外しています。
      </p>

      <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <UsageCard
          label="顧客テナント数"
          value={summary.tenantCount.toString()}
          unit="件"
        />
        <UsageCard
          label="アクティブユーザ総数"
          value={summary.totalActiveUsers.toString()}
          unit="人"
        />
        <UsageCard
          label="今月の API 呼出"
          value={summary.totalCurrentMonthApiCalls.toLocaleString()}
          unit="回"
        />
        <UsageCard
          label="今月の API 費用"
          value={`¥${summary.totalCurrentMonthApiCostJpy.toLocaleString()}`}
          unit=""
        />
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">プラン別分布</h2>
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b text-left">
              <th className="p-2">プラン</th>
              <th className="p-2 text-right">テナント数</th>
            </tr>
          </thead>
          <tbody>
            {summary.planDistribution.length === 0 ? (
              <tr>
                <td colSpan={2} className="p-4 text-center text-muted-foreground">
                  テナントがありません
                </td>
              </tr>
            ) : (
              summary.planDistribution.map((p) => (
                <tr key={p.plan} className="border-b">
                  <td className="p-2 capitalize">{p.plan}</td>
                  <td className="p-2 text-right">{p.count}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>

      <p className="text-xs text-muted-foreground">
        ℹ Voyage / Anthropic 月次集計、Supabase DB 容量モニタは Phase 2 で追加予定。
      </p>
    </div>
  );
}

function UsageCard({ label, value, unit }: { label: string; value: string; unit: string }) {
  return (
    <div className="rounded border p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1">
        <span className="text-2xl font-bold">{value}</span>
        {unit && <span className="ml-1 text-sm text-muted-foreground">{unit}</span>}
      </p>
    </div>
  );
}
