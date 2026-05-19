/**
 * /admin/super/tenants (PR-X2 / 2026-05-07)
 *
 * 全テナント一覧。tenantSeq 昇順で表示。各行から詳細画面に遷移可能。
 *
 * 2026-05-11: Default テナント (運営者自身) を顧客テナント一覧と別セクションで表示する
 *   方針に変更。請求対象外のため顧客集計には含めないが、運営者が一括管理できるようにする。
 */

import Link from 'next/link';
import {
  listAllTenants,
  getDefaultTenantOwnSummary,
  type DefaultTenantOwnSummary,
} from '@/services/super-admin.service';
// ★ PR-V8.1 (2026-05-19) 請求 invariant: ApiCallLog SUM (真値) を一覧でも表示
import { reconcileAllTenantsApiUsage } from '@/services/api-usage-recalc.service';

export default async function SuperAdminTenantsListPage() {
  const [tenants, defaultTenant, reconciles] = await Promise.all([
    listAllTenants(),
    getDefaultTenantOwnSummary(),
    reconcileAllTenantsApiUsage(),
  ]);
  const reconcileByTenant = new Map(reconciles.map((r) => [r.tenantId, r]));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">全テナント一覧</h1>
        {/* P-G (2026-05-08): 新規テナント払い出し導線 */}
        <Link
          href="/admin/super/tenants/new"
          className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-xs hover:bg-primary/90"
        >
          + 新規テナント払い出し
        </Link>
      </div>

      {/* 2026-05-11: Default テナント (運営者自身) を別セクションで表示 */}
      <DefaultTenantRow defaultTenant={defaultTenant} />

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">顧客テナント</h2>
        <p className="text-sm text-muted-foreground">
          管理テナント (運営内部) と Default テナント (運営者自身) は表示しません。tenantSeq 昇順で表示。
        </p>

        {tenants.length === 0 ? (
          <p className="rounded border p-8 text-center text-muted-foreground">
            顧客テナントはまだ登録されていません。
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b text-left">
                  <th className="p-2">#</th>
                  <th className="p-2">テナント名</th>
                  <th className="p-2">プラン</th>
                  <th className="p-2 text-right" title="ApiCallLog 集計値 (請求書根拠と同じ真値、PR-V8.1)">今月 API 呼出</th>
                  <th className="p-2 text-right" title="ApiCallLog 集計値 (請求書根拠と同じ真値、PR-V8.1)">今月 API 費用</th>
                  <th className="p-2 text-right" title="counter と SUM の乖離。値があれば修復が必要">drift</th>
                  <th className="p-2 text-right">ユーザ数</th>
                  <th className="p-2">作成日</th>
                </tr>
              </thead>
              <tbody>
                {tenants.map((t) => {
                  // ★ PR-V8.1: ApiCallLog SUM (真値) を表示。counter (currentMonth*) は内部 cache
                  const r = reconcileByTenant.get(t.id);
                  const sumCall = r?.reconciledCallCount ?? t.currentMonthApiCallCount;
                  const sumCost = r?.reconciledCostJpy ?? t.currentMonthApiCostJpy;
                  return (
                    <tr key={t.id} className="border-b hover:bg-muted/30">
                      <td className="p-2">{t.tenantSeq ?? '-'}</td>
                      <td className="p-2">
                        <Link href={`/admin/super/tenants/${t.id}`} className="text-info hover:underline">
                          {t.name}
                        </Link>
                      </td>
                      <td className="p-2 capitalize">{t.plan}</td>
                      <td className="p-2 text-right">{sumCall.toLocaleString()}</td>
                      <td className="p-2 text-right">¥{sumCost.toLocaleString()}</td>
                      <td className="p-2 text-right">
                        {r?.hasDrift ? (
                          <Link
                            href={`/admin/super/tenants/${t.id}/diagnostics`}
                            className="text-red-700 hover:underline dark:text-red-300"
                            title={`counter ${t.currentMonthApiCallCount} vs SUM ${sumCall} (差 ${t.currentMonthApiCallCount - sumCall} 件)`}
                          >
                            ⚠ {(r.driftRatio * 100).toFixed(0)}%
                          </Link>
                        ) : (
                          <span className="text-muted-foreground">-</span>
                        )}
                      </td>
                      <td className="p-2 text-right">{t.activeUserCount}</td>
                      <td className="p-2">{t.createdAt.toISOString().split('T')[0]}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

/**
 * 2026-05-11: Default テナント (運営者自身) を 1 行で表示。請求対象外なので
 * 「(請求対象外)」を費用欄に表示し、顧客テナントとの区別を視覚的に明確化する。
 */
function DefaultTenantRow({
  defaultTenant,
}: {
  defaultTenant: DefaultTenantOwnSummary | null;
}) {
  return (
    <section className="space-y-2 rounded border border-info/40 bg-info/5 p-4">
      <h2 className="text-lg font-semibold">Default テナント (運営者自身)</h2>
      <p className="text-xs text-muted-foreground">
        運営者自身のテナント。顧客集計には含まれません (= 請求対象外)
      </p>
      {!defaultTenant ? (
        <p className="text-sm text-muted-foreground">
          Default テナントが存在しません (seed 未投入または削除済)。
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b text-left">
                <th className="p-2">テナント名</th>
                <th className="p-2">プラン</th>
                <th className="p-2 text-right">今月 API 呼出</th>
                <th className="p-2 text-right">今月 API 費用</th>
                <th className="p-2 text-right">ユーザ数</th>
                <th className="p-2">作成日</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b hover:bg-muted/30">
                <td className="p-2">
                  <Link
                    href={`/admin/super/tenants/${defaultTenant.id}`}
                    className="text-info hover:underline"
                  >
                    {defaultTenant.name}
                  </Link>
                  <span className="ml-2 text-xs text-muted-foreground">/ {defaultTenant.slug}</span>
                </td>
                <td className="p-2 capitalize">{defaultTenant.plan}</td>
                <td className="p-2 text-right">
                  {defaultTenant.currentMonthApiCallCount.toLocaleString()}
                </td>
                <td className="p-2 text-right">
                  ¥{defaultTenant.currentMonthApiCostJpy.toLocaleString()}
                  <span className="ml-1 text-xs text-muted-foreground">(請求対象外)</span>
                </td>
                <td className="p-2 text-right">{defaultTenant.activeUserCount}</td>
                <td className="p-2">{defaultTenant.createdAt.toISOString().split('T')[0]}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
