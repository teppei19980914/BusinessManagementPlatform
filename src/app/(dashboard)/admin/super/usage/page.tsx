/**
 * /admin/super/usage (PR-X2 / 2026-05-07)
 *
 * 全テナント横断の使用量サマリ + CSV エクスポート + 過去月履歴 (P-5b / 2026-05-08)。
 *
 * - 当月のサマリカード (顧客テナント数 / アクティブユーザ / コール数 / 費用)
 * - プラン別分布
 * - **CSV ダウンロード** (当月 = 現在値、過去月 = 履歴テーブル)
 * - **過去 6 ヶ月の使用量履歴テーブル** (テナント x 月)
 */

import {
  getCrossTenantUsageSummary,
  listMonthlyUsageHistory,
} from '@/services/super-admin.service';

export default async function SuperAdminUsagePage() {
  const [summary, history] = await Promise.all([
    getCrossTenantUsageSummary(),
    listMonthlyUsageHistory(6),
  ]);

  // history を yearMonth ごとにグルーピング (テーブル表示用)
  const byYearMonth = new Map<string, typeof history>();
  for (const row of history) {
    const list = byYearMonth.get(row.yearMonth) ?? [];
    list.push(row);
    byYearMonth.set(row.yearMonth, list);
  }
  // yearMonth は降順 (新しい月から)
  const yearMonths = Array.from(byYearMonth.keys()).sort().reverse();

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

      {/* P-5b (2026-05-08): CSV エクスポート */}
      <section className="space-y-2 rounded border p-4">
        <h2 className="text-lg font-semibold">CSV エクスポート (請求業務用)</h2>
        <p className="text-xs text-muted-foreground">
          月次の請求業務向けに、テナント別使用量を CSV ダウンロードできます。Excel で開けるよう UTF-8 BOM 付き。
        </p>
        <div className="flex flex-wrap gap-2 text-sm">
          <a
            href="/api/admin/super/usage/export"
            className="inline-flex items-center rounded border px-3 py-1.5 hover:bg-accent"
            download
          >
            📥 当月分 (現在値) をダウンロード
          </a>
          {yearMonths.map((ym) => (
            <a
              key={ym}
              href={`/api/admin/super/usage/export?yearMonth=${ym}`}
              className="inline-flex items-center rounded border px-3 py-1.5 hover:bg-accent"
              download
            >
              📥 {ym}
            </a>
          ))}
        </div>
        {yearMonths.length === 0 && (
          <p className="text-xs text-muted-foreground">
            ℹ 過去月の履歴は月初リセット cron (毎月 1 日 00:00 UTC) 以降に蓄積されます。
          </p>
        )}
      </section>

      {/* P-5b (2026-05-08): 過去 6 ヶ月の履歴テーブル */}
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">過去 6 ヶ月の使用量履歴</h2>
        {yearMonths.length === 0 ? (
          <p className="rounded border bg-muted/30 p-4 text-sm text-muted-foreground">
            ℹ 履歴データがありません。月初リセット cron (毎月 1 日 00:00 UTC) が初回実行されると自動的に蓄積されます。
          </p>
        ) : (
          <div className="overflow-x-auto rounded border">
            <table className="w-full border-collapse text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="p-2 text-left">月</th>
                  <th className="p-2 text-left">テナント</th>
                  <th className="p-2 text-left">プラン</th>
                  <th className="p-2 text-right">API 呼出</th>
                  <th className="p-2 text-right">API 費用</th>
                  <th className="p-2 text-right">アクティブユーザ</th>
                </tr>
              </thead>
              <tbody>
                {yearMonths.flatMap((ym) =>
                  (byYearMonth.get(ym) ?? []).map((r) => (
                    <tr key={`${ym}-${r.tenantId}`} className="border-t">
                      <td className="p-2 font-mono text-xs">{ym}</td>
                      <td className="p-2">
                        {r.tenantSeq != null && (
                          <span className="mr-1 text-xs text-muted-foreground">#{r.tenantSeq}</span>
                        )}
                        {r.tenantName}
                      </td>
                      <td className="p-2 capitalize">{r.plan}</td>
                      <td className="p-2 text-right">{r.apiCallCount.toLocaleString()}</td>
                      <td className="p-2 text-right">¥{r.apiCostJpy.toLocaleString()}</td>
                      <td className="p-2 text-right">{r.activeUserCount}</td>
                    </tr>
                  )),
                )}
              </tbody>
            </table>
          </div>
        )}
      </section>
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
