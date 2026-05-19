/**
 * /admin/super/tenants/[id]/diagnostics 個別テナント診断ページ (PR-V8 / 2026-05-19)
 *
 * 「特定のテナントで今何が起きているか」を時系列で可視化する。
 * 主に counter drift の根本原因究明と修復のために使う。
 *
 * 表示内容:
 *   1. テナント基本情報
 *   2. counter vs ApiCallLog SUM 整合性 + 修復ボタン
 *   3. 直近 30 日の日別 ApiCallLog (時系列)
 *   4. counter 書き換え系 audit_log (= 「誰が・いつ・どう書き換えたか」)
 *   5. 月次履歴 (tenant_monthly_usage_history) と現在の整合性
 *
 * 認可: super_admin のみ。
 */

import { notFound } from 'next/navigation';
import Link from 'next/link';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { isSuperAdmin } from '@/lib/permissions/role';
import { getTenantDiagnostics } from '@/services/tenant-diagnostics.service';
import { RepairDriftButton } from '../../../diagnostics/repair-drift-button';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export default async function TenantDiagnosticsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await getAuthenticatedUser();
  if (user instanceof Response || !user || !isSuperAdmin(user)) {
    notFound();
  }

  const { id } = await params;
  const data = await getTenantDiagnostics(id);
  if (!data) notFound();

  const { basic, reconcile, dailyApiCalls, counterWriteAudits, monthlyHistory } = data;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold">
            個別テナント診断: {basic.name}
          </h1>
          <div className="font-mono text-xs text-muted-foreground">{basic.id}</div>
        </div>
        <div className="flex gap-2">
          <Link
            href={`/admin/super/tenants/${basic.id}`}
            className="rounded border px-3 py-1 text-sm hover:bg-background"
          >
            テナント詳細へ
          </Link>
          <Link
            href="/admin/super/diagnostics"
            className="rounded border px-3 py-1 text-sm hover:bg-background"
          >
            診断ダッシュボードへ戻る
          </Link>
        </div>
      </div>

      {/* 1. 基本情報 */}
      <section className="space-y-2">
        <h2 className="text-lg font-bold">テナント基本情報</h2>
        <dl className="grid grid-cols-2 gap-2 rounded border p-4 text-sm sm:grid-cols-4">
          <Stat label="プラン" value={basic.plan} />
          <Stat label="TZ" value={basic.timezone} />
          <Stat
            label="作成日"
            value={basic.createdAt.toISOString().split('T')[0]}
          />
          <Stat
            label="削除日"
            value={basic.deletedAt?.toISOString().split('T')[0] ?? '-'}
          />
          <Stat
            label="counter (現在値)"
            value={basic.currentMonthApiCallCount.toLocaleString()}
            emphasis
          />
          <Stat
            label="cost counter"
            value={`¥${basic.currentMonthApiCostJpy.toLocaleString()}`}
          />
          <Stat
            label="lastResetAt"
            value={basic.lastResetAt?.toISOString() ?? '記録なし'}
          />
          <Stat
            label="updatedAt"
            value={basic.updatedAt.toISOString()}
          />
        </dl>
      </section>

      {/* 2. 整合性 */}
      <section className="space-y-2">
        <h2 className="text-lg font-bold">counter vs ApiCallLog SUM 整合性</h2>
        {reconcile == null ? (
          <div className="rounded border bg-muted/30 p-3 text-sm text-muted-foreground">
            テナント不在のため reconcile 不可
          </div>
        ) : (
          <div
            className={
              reconcile.hasDrift
                ? 'rounded border border-red-300 bg-red-50 p-4 dark:border-red-700 dark:bg-red-900/20'
                : 'rounded border border-green-300 bg-green-50 p-4 dark:border-green-700 dark:bg-green-900/20'
            }
          >
            <div className="mb-2 flex items-center justify-between">
              <div className="font-semibold">
                {reconcile.hasDrift ? '🚨 drift 検出' : '✅ 整合'}
              </div>
              {reconcile.hasDrift && <RepairDriftButton tenantId={basic.id} />}
            </div>
            <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
              <Stat
                label="counter (Tenant.currentMonthApiCallCount)"
                value={reconcile.cachedCallCount.toLocaleString()}
              />
              <Stat
                label="ApiCallLog SUM (真値)"
                value={reconcile.reconciledCallCount.toLocaleString()}
              />
              <Stat
                label="呼出回数の差"
                value={`${reconcile.driftCallCount >= 0 ? '+' : ''}${reconcile.driftCallCount.toLocaleString()} 件`}
                emphasis={reconcile.hasDrift}
              />
              <Stat
                label="呼出 drift 比率"
                value={`${(reconcile.driftCallRatio * 100).toFixed(2)}%`}
              />
              <Stat
                label="cost counter"
                value={`¥${reconcile.cachedCostJpy.toLocaleString()}`}
              />
              <Stat
                label="ApiCallLog cost SUM"
                value={`¥${reconcile.reconciledCostJpy.toLocaleString()}`}
              />
              <Stat
                label="費用の差"
                value={`${reconcile.driftCostJpy >= 0 ? '+' : ''}¥${reconcile.driftCostJpy.toLocaleString()}`}
              />
              <Stat
                label="費用 drift 比率"
                value={`${(reconcile.driftCostRatio * 100).toFixed(2)}%`}
              />
              <Stat
                label="月境界 (テナント TZ)"
                value={reconcile.monthStart.toISOString()}
              />
            </dl>
          </div>
        )}
      </section>

      {/* 3. 直近 30 日の日別 ApiCallLog */}
      <section className="space-y-2">
        <h2 className="text-lg font-bold">直近 30 日の API 呼出時系列</h2>
        {dailyApiCalls.length === 0 ? (
          <div className="rounded border bg-muted/30 p-3 text-sm text-muted-foreground">
            直近 30 日に ApiCallLog の記録はありません。
          </div>
        ) : (
          <div className="overflow-x-auto rounded border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="px-3 py-2 text-left">日付 (UTC)</th>
                  <th className="px-3 py-2 text-right">呼出回数</th>
                  <th className="px-3 py-2 text-right">cost (合計)</th>
                </tr>
              </thead>
              <tbody>
                {dailyApiCalls.map((d) => (
                  <tr key={d.date} className="border-t">
                    <td className="px-3 py-1 font-mono text-xs">{d.date}</td>
                    <td className="px-3 py-1 text-right">{d.count.toLocaleString()}</td>
                    <td className="px-3 py-1 text-right">¥{d.costJpy.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="bg-muted/30 font-semibold">
                <tr>
                  <td className="px-3 py-2">合計 (30 日)</td>
                  <td className="px-3 py-2 text-right">
                    {dailyApiCalls.reduce((s, d) => s + d.count, 0).toLocaleString()}
                  </td>
                  <td className="px-3 py-2 text-right">
                    ¥
                    {dailyApiCalls.reduce((s, d) => s + d.costJpy, 0).toLocaleString()}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </section>

      {/* 4. counter 書き換え系 audit_log */}
      <section className="space-y-2">
        <h2 className="text-lg font-bold">
          counter 書き換え系 audit_log (直近 30 日)
        </h2>
        <p className="text-xs text-muted-foreground">
          repair-api-usage / recalculate-self / recalculate / monthly-reset のいずれかの operation を含む audit_log を抽出しています。
          「なぜ counter が書き換わったか」の追跡に使えます。
        </p>
        {counterWriteAudits.length === 0 ? (
          <div className="rounded border bg-muted/30 p-3 text-sm text-muted-foreground">
            該当する audit_log はありません。
            (= 直近 30 日で counter は書き換えられていない = 手動 SQL や未追跡の経路で書き換えられている可能性があります)
          </div>
        ) : (
          <div className="overflow-x-auto rounded border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="px-3 py-2 text-left">時刻</th>
                  <th className="px-3 py-2 text-left">action</th>
                  <th className="px-3 py-2 text-left">userId</th>
                  <th className="px-3 py-2 text-left">operation</th>
                  <th className="px-3 py-2 text-left">before → after</th>
                </tr>
              </thead>
              <tbody>
                {counterWriteAudits.map((a) => {
                  const op = a.afterValue?.['operation'] as string | undefined;
                  const beforeCount = a.beforeValue?.['currentMonthApiCallCount'];
                  const afterCount = a.afterValue?.['currentMonthApiCallCount'];
                  return (
                    <tr key={a.id} className="border-t">
                      <td className="px-3 py-1 font-mono text-xs">
                        {a.createdAt.toISOString()}
                      </td>
                      <td className="px-3 py-1">{a.action}</td>
                      <td className="px-3 py-1 font-mono text-xs">{a.userId}</td>
                      <td className="px-3 py-1">{op ?? '-'}</td>
                      <td className="px-3 py-1 font-mono text-xs">
                        {beforeCount !== undefined && afterCount !== undefined
                          ? `${String(beforeCount)} → ${String(afterCount)}`
                          : '-'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* 5. 月次履歴 */}
      <section className="space-y-2">
        <h2 className="text-lg font-bold">月次履歴 (過去 6 ヶ月)</h2>
        <p className="text-xs text-muted-foreground">
          tenant_monthly_usage_history に保存されたスナップショット。月初リセット cron 直前の counter 値を記録。
        </p>
        {monthlyHistory.length === 0 ? (
          <div className="rounded border bg-muted/30 p-3 text-sm text-muted-foreground">
            スナップショット記録なし
          </div>
        ) : (
          <div className="overflow-x-auto rounded border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="px-3 py-2 text-left">月</th>
                  <th className="px-3 py-2 text-left">plan</th>
                  <th className="px-3 py-2 text-right">apiCallCount</th>
                  <th className="px-3 py-2 text-right">apiCostJpy</th>
                </tr>
              </thead>
              <tbody>
                {monthlyHistory.map((m) => (
                  <tr key={m.yearMonth} className="border-t">
                    <td className="px-3 py-1 font-mono text-xs">{m.yearMonth}</td>
                    <td className="px-3 py-1">{m.plan}</td>
                    <td className="px-3 py-1 text-right">
                      {m.apiCallCount.toLocaleString()}
                    </td>
                    <td className="px-3 py-1 text-right">
                      ¥{m.apiCostJpy.toLocaleString()}
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

function Stat({
  label,
  value,
  emphasis = false,
}: {
  label: string;
  value: string;
  emphasis?: boolean;
}) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd
        className={
          emphasis
            ? 'font-mono text-base font-semibold text-red-700 dark:text-red-300'
            : 'font-mono text-sm'
        }
      >
        {value}
      </dd>
    </div>
  );
}
