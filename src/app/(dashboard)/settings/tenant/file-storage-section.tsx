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

const LEVEL_BADGE_COLORS: Record<FileStorageWarningLevel, string> = {
  none: 'bg-green-100 text-green-800',
  l1: 'bg-blue-100 text-blue-800',
  l2: 'bg-yellow-100 text-yellow-800',
  l3: 'bg-red-100 text-red-800',
};
const LEVEL_BADGE_KEYS: Record<FileStorageWarningLevel, string> = {
  none: 'dbCapacityLevelNone',
  l1: 'dbCapacityLevelL1',
  l2: 'dbCapacityLevelL2',
  l3: 'dbCapacityLevelL3',
};

export async function FileStorageSection({ tenantId }: { tenantId: string }) {
  const t = await getTranslations('tenantSettings');
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
    currentLevel in LEVEL_BADGE_COLORS ? currentLevel : 'none';
  const badgeColor = LEVEL_BADGE_COLORS[safeLevel];
  const badgeLabel = t(LEVEL_BADGE_KEYS[safeLevel]);

  // 進捗率: Beginner は 100MB 基準、Expert/Pro は 50GB (L3 監視アラート閾値) 基準
  //   2026-05-31: 50GB は累積ハードキャップではなく監視アラート閾値 (ADR-0030、write は止めない)
  const capBytes = isBeginner
    ? BEGINNER_STORAGE_FREE_TIER_BYTES
    : FILE_STORAGE_L3_HARD_CAP_BYTES;
  const usagePercent = Math.min(
    100,
    (Number(typed.storageFileBytesPeakThisMonth) / capBytes) * 100,
  );

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
          {isBeginner ? t('fileStorageTitleBeginner') : t('fileStorageTitleStandard')}
        </h2>
        {!isBeginner && (
          <span className={`rounded-full px-3 py-1 text-xs font-medium ${badgeColor}`}>
            {badgeLabel}
          </span>
        )}
        {isBeginner && beginnerOverFreeTier && (
          <span
            className="rounded-full bg-red-100 px-3 py-1 text-xs font-medium text-red-800"
            data-testid="beginner-storage-quota-exceeded-badge"
          >
            {t('fileStorageBeginnerOverFreeBadge')}
          </span>
        )}
        {isBeginner && !beginnerOverFreeTier && beginnerNearFreeTier && (
          <span className="rounded-full bg-yellow-100 px-3 py-1 text-xs font-medium text-yellow-800">
            {t('dbCapacityBeginnerNearFreeBadge')}
          </span>
        )}
        {isBeginner && !beginnerNearFreeTier && (
          <span className="rounded-full bg-green-100 px-3 py-1 text-xs font-medium text-green-800">
            {t('dbCapacityBeginnerWithinFreeBadge')}
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
          <p className="font-semibold">{t('fileStorageBeginnerOverFreeBannerTitle')}</p>
          <p className="mt-1">
            {t.rich('fileStorageBeginnerOverFreeBannerBody', {
              strong: (chunks) => <strong>{chunks}</strong>,
            })}
          </p>
          <p className="mt-1 text-xs">
            {t('dbCapacityBeginnerOverFreeBannerUpgradeLeading')}
            <a href="?tab=overview" className="font-semibold underline">
              {t('dbCapacityBeginnerOverFreeBannerUpgradeLink')}
            </a>
            {t('fileStorageBeginnerOverFreeBannerUpgradeTrailing')}
          </p>
        </div>
      )}

      <dl className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div>
          <dt className="text-sm font-medium text-gray-500">{t('dbCapacityCurrentUsage')}</dt>
          <dd className="mt-1 text-2xl font-semibold text-gray-900">
            {formatBytes(typed.storageFileBytesUsed)}
          </dd>
          <p className="mt-1 text-xs text-gray-500">
            {t('dbCapacityLatestPrefix', { value: formatDateJa(typed.storageFileBytesUsedAt) })}
          </p>
        </div>
        <div>
          <dt className="text-sm font-medium text-gray-500">{t('dbCapacityPeakLabel')}</dt>
          <dd className="mt-1 text-2xl font-semibold text-gray-900">
            {formatBytes(typed.storageFileBytesPeakThisMonth)}
          </dd>
          <p className="mt-1 text-xs text-gray-500">
            {t('dbCapacityReachedPrefix', { value: formatDateJa(typed.storageFileBytesPeakAt) })}
          </p>
        </div>
        <div>
          <dt className="text-sm font-medium text-gray-500">{t('dbCapacityEstimatedJpy')}</dt>
          <dd className="mt-1 text-2xl font-semibold text-gray-900">
            {formatJpy(estimatedJpy)}
          </dd>
          <p className="mt-1 text-xs text-gray-500">{t('dbCapacityEstimatedJpyHint')}</p>
        </div>
      </dl>

      <div className="mt-6">
        <div className="mb-1 flex items-center justify-between text-xs text-gray-600">
          <span>0</span>
          <span>
            {isBeginner
              ? t('dbCapacityBeginnerFreeTierLabel', { sizeMb: BEGINNER_STORAGE_FREE_TIER_BYTES / SI_MB_BYTES })
              : t('dbCapacityStandardL3Label')}
            {t('dbCapacityUsagePercentSuffix', { percent: usagePercent.toFixed(1) })}
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
            aria-label={t('dbCapacityUsageAria', { percent: usagePercent.toFixed(1) })}
          />
        </div>
      </div>

      <details className="mt-6 rounded border border-gray-200 bg-gray-50 p-4">
        <summary className="cursor-pointer text-sm font-medium text-gray-700">
          {isBeginner ? t('dbCapacityRulesBeginnerSummary') : t('dbCapacityRulesStandardSummary')}
        </summary>
        <div className="mt-3 space-y-2 text-sm text-gray-600">
          {isBeginner ? (
            <>
              <p>
                {t.rich('fileStorageBeginnerRuleFreeTier', {
                  strong: (chunks) => <strong>{chunks}</strong>,
                  sizeMb: BEGINNER_STORAGE_FREE_TIER_BYTES / SI_MB_BYTES,
                })}
              </p>
              <p>
                {t.rich('fileStorageBeginnerRuleFileLimit', {
                  strong: (chunks) => <strong>{chunks}</strong>,
                })}
              </p>
              <p>
                {t.rich('fileStorageBeginnerRuleOverflow', {
                  strong: (chunks) => <strong>{chunks}</strong>,
                })}
              </p>
              <p>
                {t.rich('fileStorageBeginnerRuleRecalc', {
                  strong: (chunks) => <strong>{chunks}</strong>,
                })}
              </p>
              <p className="text-xs text-gray-500">
                {t('fileStorageBeginnerRuleUpgrade')}
              </p>
            </>
          ) : (
            <>
              <p>
                {t.rich('fileStorageStandardRuleFreeTier', {
                  strong: (chunks) => <strong>{chunks}</strong>,
                  sizeMb: FILE_STORAGE_FREE_TIER_BYTES / SI_MB_BYTES,
                })}
              </p>
              <p>
                {t.rich('fileStorageStandardRuleOverage', {
                  strong: (chunks) => <strong>{chunks}</strong>,
                })}
              </p>
              <p>
                {t.rich('fileStorageBeginnerRuleFileLimit', {
                  strong: (chunks) => <strong>{chunks}</strong>,
                })}
              </p>
              <p className="text-xs text-gray-500">
                {t('fileStorageStandardRuleExamples', {
                  l1Gb: FILE_STORAGE_L1_USER_WARNING_BYTES / SI_GB_BYTES,
                  l2Gb: FILE_STORAGE_L2_ADMIN_ALERT_BYTES / SI_GB_BYTES,
                  l3Gb: FILE_STORAGE_L3_HARD_CAP_BYTES / SI_GB_BYTES,
                })}
              </p>
              <p className="text-xs text-gray-500">
                {t('fileStorageStandardRuleNote')}
              </p>
            </>
          )}
        </div>
      </details>
    </section>
  );
}
