/**
 * DB 容量従量課金セクション (テナント設定画面、ADR-0020 / 2026-05-25)
 *
 * 役割 (R12 ユーザ向け使用量可視化):
 *   テナント管理者が設定画面を開いたときに「当月の DB 使用量・peak・想定請求額」を
 *   確認できる server component。能動通知 (メール等) は行わず、設定画面アクセス時の
 *   表示のみで気付ける UX (ADR-0020 §6 / R12)。
 *
 * 表示内容:
 *   - 現在の使用量 (storageBytesUsed、最新 daily cron 同期値)
 *   - 月中 peak (storageBytesPeakThisMonth、課金根拠)
 *   - 想定請求額 (calculateOverageJpy で peak から算出、月末確定額)
 *   - 監視アラート Level バッジ (none / L1 1GB / L2 10GB / L3 50GB)
 *   - 無料枠 50MB の説明 (2026-05-31: 50GB 累積ハードキャップは撤去 ADR-0030、L3 は監視アラート閾値)
 *
 * 関連:
 *   - ADR: docs/adr/0020-db-capacity-usage-based-billing.md
 *   - 計算: src/config/db-capacity-pricing.ts
 *   - 親: src/app/(dashboard)/settings/tenant/page.tsx
 */

import { getTranslations } from 'next-intl/server';
import { prisma } from '@/lib/db';
import {
  BEGINNER_DB_FREE_TIER_BYTES,
  DB_CAPACITY_FREE_TIER_BYTES,
  DB_CAPACITY_L1_USER_WARNING_BYTES,
  DB_CAPACITY_L2_ADMIN_ALERT_BYTES,
  DB_CAPACITY_L3_HARD_CAP_BYTES,
  SI_GB_BYTES,
  SI_MB_BYTES,
  calculateOverageJpy,
  classifyDbCapacityLevel,
  type DbCapacityWarningLevel,
} from '@/config/db-capacity-pricing';

type DbCapacityData = {
  // ADR-0025 (2026-05-29): Beginner プラン判定のため plan を追加 select
  plan: string;
  storageBytesUsed: bigint;
  storageBytesPeakThisMonth: bigint;
  storageBytesUsedAt: Date | null;
  storageBytesPeakAt: Date | null;
  dbCapacityWarningLevel: string;
};

/** バイト数を人間可読形式 (KB / MB / GB) に変換 */
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

export async function DbCapacitySection({ tenantId }: { tenantId: string }) {
  const t = await getTranslations('dbCapacitySection');

  const LEVEL_BADGES: Record<DbCapacityWarningLevel, { label: string; color: string }> = {
    none: { label: t('levelNone'), color: 'bg-green-100 text-green-800' },
    l1: { label: t('levelL1'), color: 'bg-blue-100 text-blue-800' },
    l2: { label: t('levelL2'), color: 'bg-yellow-100 text-yellow-800' },
    l3: { label: t('levelL3'), color: 'bg-red-100 text-red-800' },
  };

  const data = await prisma.tenant.findFirst({
    where: { id: tenantId, deletedAt: null },
    select: {
      // ADR-0025 (2026-05-29): Beginner プラン判定のため plan を追加 select
      plan: true,
      storageBytesUsed: true,
      storageBytesPeakThisMonth: true,
      storageBytesUsedAt: true,
      storageBytesPeakAt: true,
      dbCapacityWarningLevel: true,
    },
  });
  if (!data) return null;

  const typed = data as DbCapacityData;

  // ADR-0025 (2026-05-29): Beginner プラン判定。
  //   - Beginner: 50MB 無料枠、超過で write ブロック (overage 課金なし)、削除のみ可
  //   - Expert / Pro: 上限なし従量課金 (2026-05-31: 50GB 累積ハードキャップは撤去 ADR-0030。50GB は L3 監視アラート閾値)
  const isBeginner = typed.plan === 'beginner';
  const usedBytesNum = Number(typed.storageBytesUsed);
  const beginnerOverFreeTier = isBeginner && usedBytesNum > BEGINNER_DB_FREE_TIER_BYTES;
  const beginnerNearFreeTier =
    isBeginner && usedBytesNum >= BEGINNER_DB_FREE_TIER_BYTES * 0.8;

  // 課金額算出: Beginner は常に ¥0 (ADR-0025、overage 課金なし)
  const estimatedJpy = isBeginner ? 0 : calculateOverageJpy(typed.storageBytesPeakThisMonth);
  // 現在値で classify (= 表示用の現状ステータス、Expert/Pro 用)
  const currentLevel = classifyDbCapacityLevel(typed.storageBytesPeakThisMonth);
  const safeLevel: DbCapacityWarningLevel =
    currentLevel in LEVEL_BADGES ? currentLevel : 'none';
  const badge = LEVEL_BADGES[safeLevel];

  // 進捗率: Beginner は 50MB 基準、Expert/Pro は 50GB (L3 監視アラート閾値) 基準
  //   2026-05-31: 50GB は累積ハードキャップではなく監視アラート閾値 (ADR-0030、write は止めない)
  const capBytes = isBeginner ? BEGINNER_DB_FREE_TIER_BYTES : DB_CAPACITY_L3_HARD_CAP_BYTES;
  const usagePercent = Math.min(
    100,
    (Number(typed.storageBytesPeakThisMonth) / capBytes) * 100,
  );

  const beginnerFreeMb = BEGINNER_DB_FREE_TIER_BYTES / SI_MB_BYTES;
  const expertFreeMb = DB_CAPACITY_FREE_TIER_BYTES / SI_MB_BYTES;

  return (
    <section
      className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm"
      aria-labelledby="db-capacity-section-title"
      data-testid="db-capacity-section"
      data-plan={typed.plan}
      data-beginner-over-free-tier={beginnerOverFreeTier ? 'true' : 'false'}
    >
      <div className="mb-4 flex items-center justify-between">
        <h2
          id="db-capacity-section-title"
          className="text-lg font-semibold text-gray-900"
        >
          {t('titleDb')}{isBeginner ? t('titleBeginnerSuffix') : t('titleExpertSuffix')}
        </h2>
        {!isBeginner && (
          <span className={`rounded-full px-3 py-1 text-xs font-medium ${badge.color}`}>
            {badge.label}
          </span>
        )}
        {isBeginner && beginnerOverFreeTier && (
          <span
            className="rounded-full bg-red-100 px-3 py-1 text-xs font-medium text-red-800"
            data-testid="beginner-db-quota-exceeded-badge"
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

      {/* ADR-0025: Beginner 超過時の write ブロック説明バナー */}
      {isBeginner && beginnerOverFreeTier && (
        <div
          className="mb-4 rounded-md border border-red-300 bg-red-50 p-4 text-sm text-red-900"
          role="alert"
          data-testid="beginner-db-block-banner"
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

      {/* 主要数値 */}
      <dl className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div>
          <dt className="text-sm font-medium text-gray-500">{t('statCurrentUsage')}</dt>
          <dd className="mt-1 text-2xl font-semibold text-gray-900">
            {formatBytes(typed.storageBytesUsed)}
          </dd>
          <p className="mt-1 text-xs text-gray-500">
            {t('statCurrentLatest', { date: formatDateJa(typed.storageBytesUsedAt) })}
          </p>
        </div>
        <div>
          <dt className="text-sm font-medium text-gray-500">{t('statMonthlyPeak')}</dt>
          <dd className="mt-1 text-2xl font-semibold text-gray-900">
            {formatBytes(typed.storageBytesPeakThisMonth)}
          </dd>
          <p className="mt-1 text-xs text-gray-500">
            {t('statPeakReached', { date: formatDateJa(typed.storageBytesPeakAt) })}
          </p>
        </div>
        <div>
          <dt className="text-sm font-medium text-gray-500">{t('statEstimatedBilling')}</dt>
          <dd className="mt-1 text-2xl font-semibold text-gray-900">
            {formatJpy(estimatedJpy)}
          </dd>
          <p className="mt-1 text-xs text-gray-500">
            {t('statBillingNote')}
          </p>
        </div>
      </dl>

      {/* 進捗バー (Beginner: 50MB 基準 / Expert・Pro: 50GB 基準) */}
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

      {/* 料金体系の説明 */}
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
              <p className="text-xs text-gray-500">
                {t('detailExpertExample', {
                  l1: DB_CAPACITY_L1_USER_WARNING_BYTES / SI_GB_BYTES,
                  l2: DB_CAPACITY_L2_ADMIN_ALERT_BYTES / SI_GB_BYTES,
                  l3: DB_CAPACITY_L3_HARD_CAP_BYTES / SI_GB_BYTES,
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
