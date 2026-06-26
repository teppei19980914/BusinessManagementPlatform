/**
 * ファイルストレージ従量課金セクション (テナント設定画面、ADR-0021 / 2026-05-26)
 *
 * 役割:
 *   テナント管理者が設定画面を開いたときに「当月の添付ファイル使用量・peak・想定請求額」を
 *   確認できる server component。能動通知 (メール等) は行わず、設定画面アクセス時の
 *   表示のみで気付ける UX (= db-capacity-section と同設計)。
 *
 * 表示内容:
 *   - 現在の使用量 (storageFileBytesUsed、最新 daily cron 同期値)
 *   - 月中 peak (storageFileBytesPeakThisMonth、課金根拠)
 *   - 想定請求額 (calculateFileStorageOverageJpy で peak から算出、月末確定額)
 *   - 監視アラート Level バッジ (none / L1 1GB / L2 10GB / L3 50GB)
 *   - 無料枠 100MB の説明 (2026-05-31: 50GB 累積ハードキャップは撤去 ADR-0030、L3 は監視アラート閾値)
 *
 * 関連:
 *   - ADR: docs/adr/0021-file-storage-usage-based-billing.md
 *   - 計算: src/config/file-storage-pricing.ts
 *   - 親: src/app/(dashboard)/settings/tenant/page.tsx
 *   - 同設計参考: src/app/(dashboard)/settings/tenant/db-capacity-section.tsx
 */

import { getTranslations } from 'next-intl/server';
import { prisma } from '@/lib/db';
import { syncTenantFileStorageUsage } from '@/services/file-storage-bucket-usage.service';
import {
  BEGINNER_STORAGE_FREE_TIER_BYTES,
  FILE_STORAGE_FREE_TIER_BYTES,
  FILE_STORAGE_L1_USER_WARNING_BYTES,
  FILE_STORAGE_L2_ADMIN_ALERT_BYTES,
  FILE_STORAGE_L3_HARD_CAP_BYTES,
  SI_GB_BYTES,
  SI_MB_BYTES,
  calculateFileStorageOverageJpy,
  classifyFileStorageLevel,
  type FileStorageWarningLevel,
} from '@/config/file-storage-pricing';

type FileStorageData = {
  // ADR-0025 (2026-05-29): Beginner プラン判定のため plan を追加 select
  plan: string;
  storageFileBytesUsed: bigint;
  storageFileBytesPeakThisMonth: bigint;
  storageFileBytesUsedAt: Date | null;
  storageFileBytesPeakAt: Date | null;
  fileStorageWarningLevel: string;
};

function formatBytes(bytes: bigint): string {
  const n = Number(bytes);
  if (n >= SI_GB_BYTES) return `${(n / SI_GB_BYTES).toFixed(2)} GB`;
  if (n >= SI_MB_BYTES) return `${(n / SI_MB_BYTES).toFixed(1)} MB`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)} KB`;
  return `${n} B`;
}

function formatJpy(n: number): string {
  return `¥${n.toLocaleString('ja-JP')}`;
}

function formatDateJa(d: Date | null): string {
  if (!d) return '—';
  return d.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
}

export async function FileStorageSection({ tenantId }: { tenantId: string }) {
  const t = await getTranslations('fileStorageSection');

  const LEVEL_BADGES: Record<FileStorageWarningLevel, { label: string; color: string }> = {
    none: { label: t('levelNone'), color: 'bg-green-100 text-green-800' },
    l1: { label: t('levelL1'), color: 'bg-blue-100 text-blue-800' },
    l2: { label: t('levelL2'), color: 'bg-yellow-100 text-yellow-800' },
    l3: { label: t('levelL3'), color: 'bg-red-100 text-red-800' },
  };

  // [feedback_billing_data_realtime]: ダッシュボード遷移時に再集計し誤請求リスク予防。
  //   失敗時はキャッシュ値表示に fallback (Supabase 一時不通でも UI は壊さない)。
  try {
    await syncTenantFileStorageUsage(tenantId);
  } catch {
    // ignore: 表示は既存キャッシュで継続
  }

  const data = await prisma.tenant.findFirst({
    where: { id: tenantId, deletedAt: null },
    select: {
      // ADR-0025 (2026-05-29): Beginner プラン判定のため plan を追加 select
      plan: true,
      storageFileBytesUsed: true,
      storageFileBytesPeakThisMonth: true,
      storageFileBytesUsedAt: true,
      storageFileBytesPeakAt: true,
      fileStorageWarningLevel: true,
    },
  });
  if (!data) return null;

  const typed = data as FileStorageData;

  // ADR-0025 (2026-05-29): Beginner プラン分岐
  const isBeginner = typed.plan === 'beginner';
  const usedBytesNum = Number(typed.storageFileBytesUsed);
  const beginnerOverFreeTier = isBeginner && usedBytesNum > BEGINNER_STORAGE_FREE_TIER_BYTES;
  const beginnerNearFreeTier =
    isBeginner && usedBytesNum >= BEGINNER_STORAGE_FREE_TIER_BYTES * 0.8;

  // Beginner は常に ¥0 (ADR-0025)
  const estimatedJpy = isBeginner
    ? 0
    : calculateFileStorageOverageJpy(typed.storageFileBytesPeakThisMonth);
  const currentLevel = classifyFileStorageLevel(typed.storageFileBytesPeakThisMonth);
  const safeLevel: FileStorageWarningLevel =
    currentLevel in LEVEL_BADGES ? currentLevel : 'none';
  const badge = LEVEL_BADGES[safeLevel];

  // 進捗率: Beginner は 100MB 基準、Expert/Pro は 50GB (L3 監視アラート閾値) 基準
  //   2026-05-31: 50GB は累積ハードキャップではなく監視アラート閾値 (ADR-0030、write は止めない)
  const capBytes = isBeginner
    ? BEGINNER_STORAGE_FREE_TIER_BYTES
    : FILE_STORAGE_L3_HARD_CAP_BYTES;
  const usagePercent = Math.min(
    100,
    (Number(typed.storageFileBytesPeakThisMonth) / capBytes) * 100,
  );

  const beginnerFreeMb = BEGINNER_STORAGE_FREE_TIER_BYTES / SI_MB_BYTES;
  const expertFreeMb = FILE_STORAGE_FREE_TIER_BYTES / SI_MB_BYTES;

  return (
    <section
      className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm"
      aria-labelledby="file-storage-section-title"
      data-testid="file-storage-section"
      data-plan={typed.plan}
      data-beginner-over-free-tier={beginnerOverFreeTier ? 'true' : 'false'}
    >
      <div className="mb-4 flex items-center justify-between">
        <h2
          id="file-storage-section-title"
          className="text-lg font-semibold text-gray-900"
        >
          {t('titleFile')}{isBeginner ? t('titleBeginnerSuffix') : t('titleExpertSuffix')}
        </h2>
        {!isBeginner && (
          <span className={`rounded-full px-3 py-1 text-xs font-medium ${badge.color}`}>
            {badge.label}
          </span>
        )}
        {isBeginner && beginnerOverFreeTier && (
          <span
            className="rounded-full bg-red-100 px-3 py-1 text-xs font-medium text-red-800"
            data-testid="beginner-storage-quota-exceeded-badge"
          >
            {t('badgeOverQuota')}
          </span>
        )}
        {isBeginner && !beginnerOverFreeTier && beginnerNearFreeTier && (
          <span className="rounded-full bg-yellow-100 px-3 py-1 text-xs font-medium text-yellow-800">
            {t('badgeNear80')}
          </span>
        )}
        {isBeginner && !beginnerNearFreeTier && (
          <span className="rounded-full bg-green-100 px-3 py-1 text-xs font-medium text-green-800">
            {t('badgeWithinFree')}
          </span>
        )}
      </div>

      {/* ADR-0025: Beginner 超過時のアップロードブロック説明バナー */}
      {isBeginner && beginnerOverFreeTier && (
        <div
          className="mb-4 rounded-md border border-red-300 bg-red-50 p-4 text-sm text-red-900"
          role="alert"
          data-testid="beginner-storage-block-banner"
        >
          <p className="font-semibold">{t('bannerTitle')}</p>
          <p className="mt-1">
            {t('bannerPara1Prefix')}{' '}
            <strong>{t('bannerRecalcBtn')}</strong>{' '}
            {t('bannerPara1Suffix')}
          </p>
          <p className="mt-1 text-xs">
            {t('bannerPara2Prefix')}{' '}
            <a href="?tab=overview" className="font-semibold underline">
              {t('bannerUpgradeLink')}
            </a>{' '}
            {t('bannerPara2Suffix')}
          </p>
        </div>
      )}

      <dl className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div>
          <dt className="text-sm font-medium text-gray-500">{t('statCurrentUsage')}</dt>
          <dd className="mt-1 text-2xl font-semibold text-gray-900">
            {formatBytes(typed.storageFileBytesUsed)}
          </dd>
          <p className="mt-1 text-xs text-gray-500">
            {t('statCurrentLatest', { date: formatDateJa(typed.storageFileBytesUsedAt) })}
          </p>
        </div>
        <div>
          <dt className="text-sm font-medium text-gray-500">{t('statMonthlyPeak')}</dt>
          <dd className="mt-1 text-2xl font-semibold text-gray-900">
            {formatBytes(typed.storageFileBytesPeakThisMonth)}
          </dd>
          <p className="mt-1 text-xs text-gray-500">
            {t('statPeakReached', { date: formatDateJa(typed.storageFileBytesPeakAt) })}
          </p>
        </div>
        <div>
          <dt className="text-sm font-medium text-gray-500">{t('statEstimatedBilling')}</dt>
          <dd className="mt-1 text-2xl font-semibold text-gray-900">
            {formatJpy(estimatedJpy)}
          </dd>
          <p className="mt-1 text-xs text-gray-500">{t('statBillingNote')}</p>
        </div>
      </dl>

      <div className="mt-6">
        <div className="mb-1 flex items-center justify-between text-xs text-gray-600">
          <span>0</span>
          <span>
            {isBeginner
              ? t('progressBeginnerLabel', { mb: beginnerFreeMb })
              : t('progressExpertLabel')}{' '}
            ({usagePercent.toFixed(1)}%)
          </span>
        </div>
        <div className="h-2 w-full overflow-hidden rounded-full bg-gray-200">
          <div
            className={`h-full transition-all ${
              isBeginner
                ? beginnerOverFreeTier
                  ? 'bg-red-500'
                  : beginnerNearFreeTier
                    ? 'bg-yellow-500'
                    : 'bg-green-500'
                : safeLevel === 'l3'
                  ? 'bg-red-500'
                  : safeLevel === 'l2'
                    ? 'bg-yellow-500'
                    : safeLevel === 'l1'
                      ? 'bg-blue-500'
                      : 'bg-green-500'
            }`}
            style={{ width: `${usagePercent}%` }}
            aria-label={t('progressAriaLabel', { percent: usagePercent.toFixed(1) })}
          />
        </div>
      </div>

      <details className="mt-6 rounded border border-gray-200 bg-gray-50 p-4">
        <summary className="cursor-pointer text-sm font-medium text-gray-700">
          {isBeginner ? t('summaryBeginner') : t('summaryExpert')}
        </summary>
        <div className="mt-3 space-y-2 text-sm text-gray-600">
          {isBeginner ? (
            <>
              <p>
                <strong>{t('detailFreeTierLabel')}</strong>{' '}
                {t('detailBeginnerFreeContent', { mb: beginnerFreeMb })}
              </p>
              <p>
                <strong>{t('detailFileSizeLimitLabel')}</strong>{' '}
                {t('detailFileSizeLimit')}
              </p>
              <p>
                <strong>{t('detailOverageBehaviorLabel')}</strong>{' '}
                {t('detailBeginnerOverageBehaviorPre')}
                <strong>{t('detailNotGenerated')}</strong>
                {' (ADR-0025)'}
              </p>
              <p>
                <strong>{t('detailAfterDeletionLabel')}</strong>{' '}
                {t('detailBeginnerAfterDeletion')}
              </p>
              <p className="text-xs text-gray-500">
                {t('detailBeginnerUpgradeNote')}
              </p>
            </>
          ) : (
            <>
              <p>
                <strong>{t('detailFreeTierLabel')}</strong>{' '}
                {t('detailExpertFreeContent', { mb: expertFreeMb })}
              </p>
              <p>
                <strong>{t('detailOveragePriceLabel')}</strong>{' '}
                {t('detailExpertOveragePrice')}
              </p>
              <p>
                <strong>{t('detailFileSizeLimitLabel')}</strong>{' '}
                {t('detailFileSizeLimit')}
              </p>
              <p className="text-xs text-gray-500">
                {t('detailExpertExample', {
                  l1: FILE_STORAGE_L1_USER_WARNING_BYTES / SI_GB_BYTES,
                  l2: FILE_STORAGE_L2_ADMIN_ALERT_BYTES / SI_GB_BYTES,
                  l3: FILE_STORAGE_L3_HARD_CAP_BYTES / SI_GB_BYTES,
                })}
              </p>
              <p className="text-xs text-gray-500">
                {t('detailExpertNote')}
              </p>
            </>
          )}
        </div>
      </details>
    </section>
  );
}
