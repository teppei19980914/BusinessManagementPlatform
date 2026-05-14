/**
 * /admin/super/usage (PR-X2 / 2026-05-07)
 *
 * 全テナント横断の使用量サマリ + CSV エクスポート + 過去月履歴 (P-5b / 2026-05-08)。
 *
 * - 当月のサマリカード (顧客テナント数 / アクティブユーザ / コール数 / 費用)
 * - プラン別分布
 * - **CSV ダウンロード** (当月 = 現在値、過去月 = 履歴テーブル)
 * - **過去 6 ヶ月の使用量履歴テーブル** (テナント x 月)
 *
 * 2026-05-11 改訂:
 *   - 「今月の費用」を LLM + Storage add-on 合算に変更し、内訳を補助行で併記
 *   - Default テナント (運営者自身) のサマリを別セクションで表示 (請求対象外)
 */

import Link from 'next/link';
import {
  getCrossTenantUsageSummary,
  getDefaultTenantOwnSummary,
  listMonthlyUsageHistory,
  type DefaultTenantOwnSummary,
} from '@/services/super-admin.service';

export default async function SuperAdminUsagePage() {
  const [summary, defaultTenant, history] = await Promise.all([
    getCrossTenantUsageSummary(),
    getDefaultTenantOwnSummary(),
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
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">使用量サマリ (全テナント横断)</h1>
      <p className="text-sm text-muted-foreground">
        管理テナント (運営内部) と Default テナント (運営者自身) は顧客集計から除外しています。
        Default テナントの情報は下部の専用セクションを参照してください。
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
        {/* 2026-05-11: LLM + Storage add-on 合算課金 + 内訳併記 */}
        <UsageCard
          label="今月の合計課金 (LLM + Storage)"
          value={`¥${summary.totalCurrentMonthCombinedJpy.toLocaleString()}`}
          unit=""
          subValue={`LLM ¥${summary.totalCurrentMonthApiCostJpy.toLocaleString()} + Storage ¥${summary.totalCurrentMonthStorageJpy.toLocaleString()}`}
        />
      </section>

      {/* 2026-05-11: Default テナント (運営者自身) サマリを別セクション */}
      <DefaultTenantUsageSection defaultTenant={defaultTenant} />

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">プラン別分布</h2>
        <p className="text-xs text-muted-foreground">
          顧客テナントのみ集計 (Default テナント = 運営者自身は別セクションを参照)
        </p>
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
                  顧客テナントがありません
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

      {/* P-5b (2026-05-08): CSV エクスポート / 2026-05-14: 解約済テナント込みエクスポート追加 */}
      <section className="space-y-2 rounded border p-4">
        <h2 className="text-lg font-semibold">CSV エクスポート (請求業務用)</h2>
        <p className="text-xs text-muted-foreground">
          月次の請求業務向けに、テナント別使用量を CSV ダウンロードできます。Excel で開けるよう UTF-8 BOM 付き。
        </p>

        {/* 通常 (アクティブテナントのみ) */}
        <div className="space-y-1">
          <p className="text-xs font-semibold text-muted-foreground">アクティブテナントのみ</p>
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
        </div>

        {/* 2026-05-14: 解約済テナント込み (月途中解約の請求漏れ検知用) */}
        <div className="mt-3 space-y-1 rounded border border-amber-300 bg-amber-50 p-3 dark:bg-amber-900/20">
          <p className="text-xs font-semibold text-amber-900 dark:text-amber-100">
            🔍 解約済テナントも含む (月途中解約の請求漏れ検知)
          </p>
          <p className="text-xs text-muted-foreground">
            「解約日」列が追加され、月の途中で解約されたテナントもこの CSV に含まれます。
            解約日までの利用分を請求する運用に使用します。
            詳細は <code className="text-xs">docs/operations/BILLING_MONTHLY_OPERATIONS.md</code> を参照。
          </p>
          <div className="flex flex-wrap gap-2 text-sm">
            <a
              href="/api/admin/super/usage/export?includeDeleted=true"
              className="inline-flex items-center rounded border border-amber-400 bg-white px-3 py-1.5 hover:bg-accent dark:bg-amber-950/40"
              download
            >
              📥 当月分 (現在値、解約済込み)
            </a>
            {yearMonths.map((ym) => (
              <a
                key={`with-deleted-${ym}`}
                href={`/api/admin/super/usage/export?yearMonth=${ym}&includeDeleted=true`}
                className="inline-flex items-center rounded border border-amber-400 bg-white px-3 py-1.5 hover:bg-accent dark:bg-amber-950/40"
                download
              >
                📥 {ym} (解約済込み)
              </a>
            ))}
          </div>
        </div>

        {yearMonths.length === 0 && (
          <p className="text-xs text-muted-foreground">
            ℹ 過去月の履歴は月初リセット cron (毎月 1 日 00:00 UTC) 以降に蓄積されます。
            月の途中で解約されたテナントは deleteTenant() のスナップショットで即座に履歴に記録されます (2026-05-14)。
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

function UsageCard({
  label,
  value,
  unit,
  subValue,
}: {
  label: string;
  value: string;
  unit: string;
  /** 2026-05-11: 内訳など補助テキスト */
  subValue?: string;
}) {
  return (
    <div className="rounded border p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1">
        <span className="text-2xl font-bold">{value}</span>
        {unit && <span className="ml-1 text-sm text-muted-foreground">{unit}</span>}
      </p>
      {subValue && <p className="mt-1 text-xs text-muted-foreground">{subValue}</p>}
    </div>
  );
}

/**
 * 2026-05-11: Default テナント (運営者自身) の使用量サマリを別セクションで表示。
 */
function DefaultTenantUsageSection({
  defaultTenant,
}: {
  defaultTenant: DefaultTenantOwnSummary | null;
}) {
  return (
    <section className="space-y-2 rounded border border-info/40 bg-info/5 p-4">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold">Default テナント (運営者自身)</h2>
        {defaultTenant && (
          <Link
            href={`/admin/super/tenants/${defaultTenant.id}`}
            className="text-xs text-info hover:underline"
          >
            詳細を見る →
          </Link>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        運営者自身のテナント。顧客集計には含まれません (= 請求対象外)
      </p>
      {!defaultTenant ? (
        <p className="text-sm text-muted-foreground">
          Default テナントが存在しません (seed 未投入または削除済)。
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <UsageCard
            label="アクティブユーザ"
            value={defaultTenant.activeUserCount.toString()}
            unit="人"
          />
          <UsageCard
            label="今月の API 呼出"
            value={defaultTenant.currentMonthApiCallCount.toLocaleString()}
            unit="回"
          />
          <UsageCard
            label="今月の API 費用 (参考)"
            value={`¥${defaultTenant.currentMonthApiCostJpy.toLocaleString()}`}
            unit=""
            subValue="(請求対象外)"
          />
          <UsageCard
            label="Storage プラン / 使用"
            value={defaultTenant.storageAddonPlan}
            unit=""
            subValue={`${formatBytesLocal(defaultTenant.storageBytesUsed)} / ${formatBytesLocal(defaultTenant.storageLimitBytes)}`}
          />
        </div>
      )}
    </section>
  );
}

function formatBytesLocal(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
