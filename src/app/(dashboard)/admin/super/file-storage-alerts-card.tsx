/**
 * super_admin ファイルストレージ アラートカード (ADR-0021 / 2026-05-26)
 *
 * 役割:
 *   super_admin ダッシュボードで以下を可視化:
 *   - L1-L3 警告 Level に到達しているテナント一覧
 *   - drift 検知: 全テナント Attachment SUM vs storage.objects 実容量の乖離率
 *   - anomaly 検知: 24h で +5GB 以上増加したテナントの簡易表示
 *
 * 設計参考: db-capacity-alerts-card.tsx と同パターン (= 視覚的統一感)
 */

import { getTranslations } from 'next-intl/server';
import { prisma } from '@/lib/db';
import {
  FILE_STORAGE_DRIFT_WARNING_RATIO,
  FILE_STORAGE_DRIFT_CRITICAL_RATIO,
  FILE_STORAGE_ANOMALY_DAILY_INCREASE_BYTES,
  SI_GB_BYTES,
  SI_MB_BYTES,
  type FileStorageWarningLevel,
} from '@/config/file-storage-pricing';
import { detectFileStorageDrift } from '@/services/file-storage-bucket-usage.service';
import { auth } from '@/lib/auth';
import { isSuperAdmin } from '@/lib/permissions/role';
import { recordError } from '@/services/error-log.service';

function isValidWarningLevel(value: string): value is FileStorageWarningLevel {
  return value === 'none' || value === 'l1' || value === 'l2' || value === 'l3';
}

function formatBytes(bytes: bigint): string {
  const n = Number(bytes);
  if (n >= SI_GB_BYTES) return `${(n / SI_GB_BYTES).toFixed(2)} GB`;
  if (n >= SI_MB_BYTES) return `${(n / SI_MB_BYTES).toFixed(1)} MB`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)} KB`;
  return `${n} B`;
}

const LEVEL_COLORS: Record<FileStorageWarningLevel, string> = {
  none: 'text-gray-600',
  l1: 'text-blue-700 bg-blue-50',
  l2: 'text-yellow-700 bg-yellow-50',
  l3: 'text-red-700 bg-red-50',
};
const LEVEL_LABEL_KEYS: Record<FileStorageWarningLevel, string> = {
  none: 'alertsLevelNone',
  l1: 'alertsLevelL1',
  l2: 'alertsLevelL2',
  l3: 'alertsLevelL3',
};

export async function FileStorageAlertsCard() {
  const t = await getTranslations('superAdmin');
  const session = await auth();
  if (!session?.user || !isSuperAdmin(session.user)) {
    return null;
  }

  // 1. L1+ レベルテナント一覧 (= 意図的に全テナント横断、super_admin role gate 済)
  const alertTenants = await prisma.tenant.findMany({
    where: {
      deletedAt: null,
      fileStorageWarningLevel: { in: ['l1', 'l2', 'l3'] },
    },
    select: {
      id: true,
      name: true,
      slug: true,
      tenantSeq: true,
      storageFileBytesPeakThisMonth: true,
      storageFileBytesPeakAt: true,
      fileStorageWarningLevel: true,
      storageFileBytesUsed: true,
      storageFileBytesYesterday: true,
    },
    orderBy: { storageFileBytesPeakThisMonth: 'desc' },
    take: 20,
  });

  // 2. drift 検知 (= Attachment SUM vs storage.objects)
  const drift = await detectFileStorageDrift().catch(() => ({
    attachmentSumBytes: BigInt(0),
    bucketSumBytes: BigInt(0),
    driftRatio: 0,
    driftLevel: 'ok' as const,
  }));

  const driftColor =
    drift.driftLevel === 'critical'
      ? 'text-red-700 bg-red-50'
      : drift.driftLevel === 'warning'
        ? 'text-yellow-700 bg-yellow-50'
        : 'text-green-700 bg-green-50';

  // 3. anomaly: 24h で +5GB 以上のテナント (= 表示中の上位 20 件から抽出)
  const anomalyTenants = alertTenants.filter((tenant) => {
    if (tenant.storageFileBytesYesterday == null) return false;
    return tenant.storageFileBytesUsed - tenant.storageFileBytesYesterday >= BigInt(FILE_STORAGE_ANOMALY_DAILY_INCREASE_BYTES);
  });

  return (
    <section
      className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm"
      aria-labelledby="file-storage-alerts-title"
    >
      <h2 id="file-storage-alerts-title" className="mb-4 text-lg font-semibold text-gray-900">
        {t('fileStorageAlertsTitle')}
      </h2>

      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className={`rounded p-3 ${driftColor}`}>
          <div className="text-xs font-medium">{t('driftDetectionLabel')}</div>
          <div className="mt-1 text-lg font-semibold">
            {(drift.driftRatio * 100).toFixed(1)}%
          </div>
          <div className="text-xs">
            {drift.driftLevel === 'critical'
              ? t('driftRangeCritical', { ratio: FILE_STORAGE_DRIFT_CRITICAL_RATIO * 100 })
              : drift.driftLevel === 'warning'
                ? t('driftRangeWarning', { ratio: FILE_STORAGE_DRIFT_WARNING_RATIO * 100 })
                : t('driftRangeNormal')}
          </div>
        </div>
        <div>
          <div className="text-xs font-medium text-gray-500">attachment SUM</div>
          <div className="mt-1 text-lg font-semibold text-gray-900">
            {formatBytes(drift.attachmentSumBytes)}
          </div>
        </div>
        <div>
          <div className="text-xs font-medium text-gray-500">{t('fileStorageObjectsActualSize')}</div>
          <div className="mt-1 text-lg font-semibold text-gray-900">
            {formatBytes(drift.bucketSumBytes)}
          </div>
        </div>
      </div>

      {anomalyTenants.length > 0 && (
        <div className="mb-4 rounded border border-orange-200 bg-orange-50 p-3 text-sm text-orange-700">
          {'⚠️ '}
          {t.rich('fileStorageAnomalyWarning', {
            count: anomalyTenants.length,
            gb: FILE_STORAGE_ANOMALY_DAILY_INCREASE_BYTES / SI_GB_BYTES,
            strong: (chunks) => <strong>{chunks}</strong>,
          })}
        </div>
      )}

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
                const rawLevel = tenant.fileStorageWarningLevel;
                const safeLevel: FileStorageWarningLevel = isValidWarningLevel(rawLevel)
                  ? rawLevel
                  : 'none';
                if (!isValidWarningLevel(rawLevel)) {
                  recordError({
                    severity: 'warn',
                    source: 'server',
                    message: `[file-storage-alerts] invalid fileStorageWarningLevel (tenant=${tenant.id})`,
                    context: {
                      kind: 'file_storage_alerts_invalid_level',
                      tenantId: tenant.id,
                      rawLevel,
                    },
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
                      {formatBytes(tenant.storageFileBytesPeakThisMonth)}
                    </td>
                    <td className="py-2 text-xs text-gray-600">
                      {tenant.storageFileBytesPeakAt
                        ? tenant.storageFileBytesPeakAt.toLocaleString('ja-JP', {
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
