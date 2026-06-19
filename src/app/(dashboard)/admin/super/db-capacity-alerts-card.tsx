/**
 * super_admin DB 容量アラートカード (ADR-0020 / 2026-05-25)
 *
 * 役割 (R12-admin / R14):
 *   super_admin ダッシュボードで以下を可視化:
 *   - L1-L3 警告 Level に到達しているテナント一覧
 *   - drift 検知: 全テナント peak SUM vs pg_database_size の乖離率
 *
 * これにより:
 *   - L1 通知 (1GB): 高使用量テナントの早期把握
 *   - L2 通知 (10GB): super_admin alert (= 個別ヒアリング判断)
 *   - L3 通知 (50GB): 50GB 到達テナント (= Supabase Compute 増強検討の合図。2026-05-31: write は止めない ADR-0030)
 *   - drift > 50% warning / > 100% critical: 計測漏れ or 運営直接 SQL の疑い
 *
 * 関連:
 *   - ADR: docs/adr/0020-db-capacity-usage-based-billing.md §4 (4 層防御) / §8.3 (drift)
 *   - config: src/config/db-capacity-pricing.ts (DB_DRIFT_*, classifyDbCapacityLevel)
 *   - 計測: src/services/tenant-storage-tables.service.ts (getDbInstanceSizeBytes)
 */

import { getTranslations } from 'next-intl/server';
import { prisma } from '@/lib/db';
import {
  DB_DRIFT_WARNING_RATIO,
  DB_DRIFT_CRITICAL_RATIO,
  SI_GB_BYTES,
  SI_MB_BYTES,
  type DbCapacityWarningLevel,
} from '@/config/db-capacity-pricing';
import { getDbInstanceSizeBytes } from '@/services/tenant-storage-tables.service';
import { auth } from '@/lib/auth';
import { isSuperAdmin } from '@/lib/permissions/role';
import { recordError } from '@/services/error-log.service';

/** DB から取った警告 Level の値が DbCapacityWarningLevel に収まるか型ガード */
function isValidWarningLevel(value: string): value is DbCapacityWarningLevel {
  return value === 'none' || value === 'l1' || value === 'l2' || value === 'l3';
}

function formatBytes(bytes: bigint): string {
  const n = Number(bytes);
  if (n >= SI_GB_BYTES) return `${(n / SI_GB_BYTES).toFixed(2)} GB`;
  if (n >= SI_MB_BYTES) return `${(n / SI_MB_BYTES).toFixed(1)} MB`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)} KB`;
  return `${n} B`;
}

const LEVEL_COLORS: Record<DbCapacityWarningLevel, string> = {
  none: 'text-gray-600',
  l1: 'text-blue-700 bg-blue-50',
  l2: 'text-yellow-700 bg-yellow-50',
  l3: 'text-red-700 bg-red-50',
};
const LEVEL_LABEL_KEYS: Record<DbCapacityWarningLevel, string> = {
  none: 'alertsLevelNone',
  l1: 'alertsLevelL1',
  l2: 'alertsLevelL2',
  l3: 'alertsLevelL3',
};

export async function DbCapacityAlertsCard() {
  const t = await getTranslations('superAdmin');
  // 6 回目検証 (重大-3) で追加した内部認可チェック (= 親 page 認可に依存しない defense-in-depth)
  const session = await auth();
  if (!session?.user || !isSuperAdmin(session.user)) {
    return null;
  }

  // 1. L1+ レベルテナント一覧 (none を除く)
  const alertTenants = await prisma.tenant.findMany({
    where: {
      deletedAt: null,
      dbCapacityWarningLevel: { in: ['l1', 'l2', 'l3'] },
    },
    select: {
      id: true,
      name: true,
      slug: true,
      tenantSeq: true,
      storageBytesPeakThisMonth: true,
      storageBytesPeakAt: true,
      dbCapacityWarningLevel: true,
      storageGuardCircuitOpenedAt: true,
    },
    orderBy: { storageBytesPeakThisMonth: 'desc' },
    take: 20,
  });

  // 2. drift 検知 (全テナント peak SUM vs pg_database_size)
  // 6 回目検証 (重大-1): findMany 全件 → aggregate _sum で メモリ効率化 (5000+ テナント環境対応)
  const peakAggregate = await prisma.tenant.aggregate({
    where: { deletedAt: null },
    _sum: { storageBytesPeakThisMonth: true },
  });
  const tenantPeakSum = peakAggregate._sum.storageBytesPeakThisMonth ?? BigInt(0);

  let dbInstanceSize: bigint;
  try {
    dbInstanceSize = await getDbInstanceSizeBytes();
  } catch {
    dbInstanceSize = BigInt(0);
  }

  // drift ratio = (instance - tenantSum) / tenantSum, 0 除算回避
  let driftRatio = 0;
  if (tenantPeakSum > BigInt(0)) {
    const diff = dbInstanceSize > tenantPeakSum ? dbInstanceSize - tenantPeakSum : BigInt(0);
    driftRatio = Number(diff) / Number(tenantPeakSum);
  }
  const driftLevel: 'ok' | 'warning' | 'critical' =
    driftRatio >= DB_DRIFT_CRITICAL_RATIO
      ? 'critical'
      : driftRatio >= DB_DRIFT_WARNING_RATIO
        ? 'warning'
        : 'ok';

  const driftColor =
    driftLevel === 'critical'
      ? 'text-red-700 bg-red-50'
      : driftLevel === 'warning'
        ? 'text-yellow-700 bg-yellow-50'
        : 'text-green-700 bg-green-50';

  // 3. circuit breaker open 中テナント数
  //    ⚠ 2026-05-31 (ADR-0030): circuit-breaker は撤去 (fail-open 化) のため openedAt は二度と立たず、
  //      本カウントは常に 0 (= banner 非表示)。schema 列削除と同 PR で本表示も撤去予定。
  const circuitOpenCount = alertTenants.filter(
    (tenant) => tenant.storageGuardCircuitOpenedAt != null,
  ).length;

  return (
    <section
      className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm"
      aria-labelledby="db-capacity-alerts-title"
    >
      <h2 id="db-capacity-alerts-title" className="mb-4 text-lg font-semibold text-gray-900">
        {t('dbAlertsTitle')}
      </h2>

      {/* drift 検知 + circuit open 件数 サマリ */}
      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className={`rounded p-3 ${driftColor}`}>
          <div className="text-xs font-medium">{t('driftDetectionLabel')}</div>
          <div className="mt-1 text-lg font-semibold">
            {(driftRatio * 100).toFixed(1)}%
          </div>
          <div className="text-xs">
            {driftLevel === 'critical'
              ? t('driftRangeCritical', { ratio: DB_DRIFT_CRITICAL_RATIO * 100 })
              : driftLevel === 'warning'
                ? t('driftRangeWarning', { ratio: DB_DRIFT_WARNING_RATIO * 100 })
                : t('driftRangeNormal')}
          </div>
        </div>
        <div>
          <div className="text-xs font-medium text-gray-500">tenant peak SUM</div>
          <div className="mt-1 text-lg font-semibold text-gray-900">
            {formatBytes(tenantPeakSum)}
          </div>
        </div>
        <div>
          <div className="text-xs font-medium text-gray-500">pg_database_size</div>
          <div className="mt-1 text-lg font-semibold text-gray-900">
            {formatBytes(dbInstanceSize)}
          </div>
        </div>
      </div>

      {circuitOpenCount > 0 && (
        <div className="mb-4 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {'⚠️ '}
          {t.rich('dbCircuitOpenWarning', {
            count: circuitOpenCount,
            strong: (chunks) => <strong>{chunks}</strong>,
          })}
          <code>POST /api/admin/super/tenants/[id]/storage-guard-reset</code>
          {t('dbCircuitOpenWarningSuffix')}
        </div>
      )}

      {/* テナント一覧 */}
      <div>
        <h3 className="mb-2 text-sm font-medium text-gray-700">
          {t('warningTenantsTitle', { count: alertTenants.length })}
        </h3>
        {alertTenants.length === 0 ? (
          <p className="text-sm text-gray-500">
            {t('noWarningTenants')}
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-gray-200 text-left text-xs text-gray-500">
              <tr>
                <th className="pb-2 pr-2">{t('colTenant')}</th>
                <th className="pb-2 pr-2">Level</th>
                <th className="pb-2 pr-2 text-right">{t('colMonthPeak')}</th>
                <th className="pb-2">{t('colPeakReachedAt')}</th>
              </tr>
            </thead>
            <tbody>
              {alertTenants.map((tenant) => {
                // 6 回目検証 (重大-3): cast 前に型ガードで検証 (= DB に不正値が入っていても安全)
                const rawLevel = tenant.dbCapacityWarningLevel;
                const safeLevel: DbCapacityWarningLevel = isValidWarningLevel(rawLevel)
                  ? rawLevel
                  : 'none';
                if (!isValidWarningLevel(rawLevel)) {
                  // 不正値検知時は async fire-and-forget で error log
                  recordError({
                    severity: 'warn',
                    source: 'server',
                    message: `[db-capacity-alerts] invalid dbCapacityWarningLevel (tenant=${tenant.id})`,
                    context: { kind: 'db_capacity_alerts_invalid_level', tenantId: tenant.id, rawLevel },
                  }).catch(() => {});
                }
                const levelColor = LEVEL_COLORS[safeLevel];
                const levelLabel = t(LEVEL_LABEL_KEYS[safeLevel]);
                return (
                  <tr key={tenant.id} className="border-b border-gray-100">
                    <td className="py-2 pr-2">
                      <div className="font-medium">{tenant.name}</div>
                      <div className="text-xs text-gray-500">
                        #{tenant.tenantSeq ?? '—'} / {tenant.slug}
                      </div>
                    </td>
                    <td className="py-2 pr-2">
                      <span
                        className={`rounded px-2 py-0.5 text-xs font-medium ${levelColor}`}
                      >
                        {levelLabel}
                      </span>
                    </td>
                    <td className="py-2 pr-2 text-right font-mono">
                      {formatBytes(tenant.storageBytesPeakThisMonth)}
                    </td>
                    <td className="py-2 text-xs text-gray-600">
                      {tenant.storageBytesPeakAt
                        ? tenant.storageBytesPeakAt.toLocaleString('ja-JP', {
                            timeZone: 'Asia/Tokyo',
                          })
                        : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
