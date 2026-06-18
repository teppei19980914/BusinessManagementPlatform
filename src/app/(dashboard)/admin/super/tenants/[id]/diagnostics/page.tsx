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
import { getTranslations } from 'next-intl/server';
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

  const t = await getTranslations('superAdmin');
  const { id } = await params;
  const data = await getTenantDiagnostics(id);
  if (!data) notFound();

  const { basic, reconcile, dailyApiCalls, counterWriteAudits, monthlyHistory } = data;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold">
            {t('tenantDiagnosticsTitle', { name: basic.name })}
          </h1>
          <div className="font-mono text-xs text-muted-foreground">{basic.id}</div>
        </div>
        <div className="flex gap-2">
          <Link
            href={`/admin/super/tenants/${basic.id}`}
            className="rounded border px-3 py-1 text-sm hover:bg-background"
          >
            {t('tenantDiagnosticsBackToDetail')}
          </Link>
          <Link
            href="/admin/super/diagnostics"
            className="rounded border px-3 py-1 text-sm hover:bg-background"
          >
            {t('tenantDiagnosticsBackToDashboard')}
          </Link>
        </div>
      </div>

      {/* 1. 基本情報 */}
      <section className="space-y-2">
        <h2 className="text-lg font-bold">{t('tenantDiagnosticsBasicTitle')}</h2>
        <dl className="grid grid-cols-2 gap-2 rounded border p-4 text-sm sm:grid-cols-4">
          <Stat label={t('tenantDiagnosticsStatPlan')} value={basic.plan} />
          <Stat label={t('tenantDiagnosticsStatTz')} value={basic.timezone} />
          <Stat
            label={t('tenantDiagnosticsStatCreatedAt')}
            value={basic.createdAt.toISOString().split('T')[0]}
          />
          <Stat
            label={t('tenantDiagnosticsStatDeletedAt')}
            value={basic.deletedAt?.toISOString().split('T')[0] ?? '-'}
          />
          <Stat
            label={t('tenantDiagnosticsStatCounter')}
            value={basic.currentMonthApiCallCount.toLocaleString()}
            emphasis
          />
          <Stat
            label={t('tenantDiagnosticsStatCostCounter')}
            value={`¥${basic.currentMonthApiCostJpy.toLocaleString()}`}
          />
          <Stat
            label={t('tenantDiagnosticsStatLastResetAt')}
            value={basic.lastResetAt?.toISOString() ?? t('tenantDiagnosticsStatLastResetEmpty')}
          />
          <Stat
            label={t('tenantDiagnosticsStatUpdatedAt')}
            value={basic.updatedAt.toISOString()}
          />
        </dl>
      </section>

      {/* 2. 整合性 */}
      <section className="space-y-2">
        <h2 className="text-lg font-bold">{t('tenantDiagnosticsReconcileTitle')}</h2>
        {reconcile == null ? (
          <div className="rounded border bg-muted/30 p-3 text-sm text-muted-foreground">
            {t('tenantDiagnosticsReconcileMissing')}
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
                {reconcile.hasDrift ? t('tenantDiagnosticsDriftDetected') : t('tenantDiagnosticsDriftConsistent')}
              </div>
              {reconcile.hasDrift && <RepairDriftButton tenantId={basic.id} />}
            </div>
            <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
              <Stat
                label={t('tenantDiagnosticsStatCachedCallCount')}
                value={reconcile.cachedCallCount.toLocaleString()}
              />
              <Stat
                label={t('tenantDiagnosticsStatReconciledCallCount')}
                value={reconcile.reconciledCallCount.toLocaleString()}
              />
              <Stat
                label={t('tenantDiagnosticsStatDriftCallCount')}
                value={t('tenantDiagnosticsStatDriftCallCountValue', {
                  sign: reconcile.driftCallCount >= 0 ? '+' : '',
                  count: reconcile.driftCallCount.toLocaleString(),
                })}
                emphasis={reconcile.hasDrift}
              />
              <Stat
                label={t('tenantDiagnosticsStatDriftCallRatio')}
                value={`${(reconcile.driftCallRatio * 100).toFixed(2)}%`}
              />
              <Stat
                label={t('tenantDiagnosticsStatCachedCostJpy')}
                value={`¥${reconcile.cachedCostJpy.toLocaleString()}`}
              />
              <Stat
                label={t('tenantDiagnosticsStatReconciledCostJpy')}
                value={`¥${reconcile.reconciledCostJpy.toLocaleString()}`}
              />
              <Stat
                label={t('tenantDiagnosticsStatDriftCostJpy')}
                value={t('tenantDiagnosticsStatDriftCostJpyValue', {
                  sign: reconcile.driftCostJpy >= 0 ? '+' : '',
                  value: reconcile.driftCostJpy.toLocaleString(),
                })}
              />
              <Stat
                label={t('tenantDiagnosticsStatDriftCostRatio')}
                value={`${(reconcile.driftCostRatio * 100).toFixed(2)}%`}
              />
              <Stat
                label={t('tenantDiagnosticsStatMonthStart')}
                value={reconcile.monthStart.toISOString()}
              />
            </dl>
          </div>
        )}
      </section>

      {/* 3. 直近 30 日の日別 ApiCallLog */}
      <section className="space-y-2">
        <h2 className="text-lg font-bold">{t('tenantDiagnosticsDailyApiTitle')}</h2>
        {dailyApiCalls.length === 0 ? (
          <div className="rounded border bg-muted/30 p-3 text-sm text-muted-foreground">
            {t('tenantDiagnosticsDailyApiEmpty')}
          </div>
        ) : (
          <div className="overflow-x-auto rounded border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="px-3 py-2 text-left">{t('tenantDiagnosticsDailyColDate')}</th>
                  <th className="px-3 py-2 text-right">{t('tenantDiagnosticsDailyColCount')}</th>
                  <th className="px-3 py-2 text-right">{t('tenantDiagnosticsDailyColCost')}</th>
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
                  <td className="px-3 py-2">{t('tenantDiagnosticsDailyTotalLabel')}</td>
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
          {t('tenantDiagnosticsAuditTitle')}
        </h2>
        <p className="text-xs text-muted-foreground">
          {t('tenantDiagnosticsAuditDescription')}
        </p>
        {counterWriteAudits.length === 0 ? (
          <div className="rounded border bg-muted/30 p-3 text-sm text-muted-foreground">
            {t('tenantDiagnosticsAuditEmpty')}
          </div>
        ) : (
          <div className="overflow-x-auto rounded border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="px-3 py-2 text-left">{t('tenantDiagnosticsAuditColTime')}</th>
                  <th className="px-3 py-2 text-left">action</th>
                  <th className="px-3 py-2 text-left">{t('tenantDiagnosticsAuditColUserId')}</th>
                  <th className="px-3 py-2 text-left">{t('tenantDiagnosticsAuditColOperation')}</th>
                  <th className="px-3 py-2 text-left">{t('tenantDiagnosticsAuditColBeforeAfter')}</th>
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
        <h2 className="text-lg font-bold">{t('tenantDiagnosticsMonthlyTitle')}</h2>
        <p className="text-xs text-muted-foreground">
          {t('tenantDiagnosticsMonthlyDescription')}
        </p>
        {monthlyHistory.length === 0 ? (
          <div className="rounded border bg-muted/30 p-3 text-sm text-muted-foreground">
            {t('tenantDiagnosticsMonthlyEmpty')}
          </div>
        ) : (
          <div className="overflow-x-auto rounded border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="px-3 py-2 text-left">{t('tenantDiagnosticsMonthlyColMonth')}</th>
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
