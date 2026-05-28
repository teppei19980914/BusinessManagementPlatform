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
 *   - 4 層防御 Level バッジ (none / L1 1GB / L2 10GB / L3 50GB)
 *   - 無料枠 100MB / ハードキャップ 50GB の説明
 *
 * 関連:
 *   - ADR: docs/adr/0021-file-storage-usage-based-billing.md
 *   - 計算: src/config/file-storage-pricing.ts
 *   - 親: src/app/(dashboard)/settings/tenant/page.tsx
 *   - 同設計参考: src/app/(dashboard)/settings/tenant/db-capacity-section.tsx
 */

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

const LEVEL_BADGES: Record<FileStorageWarningLevel, { label: string; color: string }> = {
  none: { label: '正常', color: 'bg-green-100 text-green-800' },
  l1: { label: 'Level 1 (1GB 到達)', color: 'bg-blue-100 text-blue-800' },
  l2: { label: 'Level 2 (10GB 到達)', color: 'bg-yellow-100 text-yellow-800' },
  l3: { label: 'Level 3 (50GB / ハードキャップ到達)', color: 'bg-red-100 text-red-800' },
};

export async function FileStorageSection({ tenantId }: { tenantId: string }) {
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

  // 進捗率: Beginner は 100MB 基準、Expert/Pro は 50GB 基準
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
          ファイルストレージ
          {isBeginner ? ' (Beginner プラン 無料枠 100MB)' : ' (添付ファイル従量課金)'}
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
            無料枠超過 (アップロードブロック中)
          </span>
        )}
        {isBeginner && !beginnerOverFreeTier && beginnerNearFreeTier && (
          <span className="rounded-full bg-yellow-100 px-3 py-1 text-xs font-medium text-yellow-800">
            無料枠の 80% に到達
          </span>
        )}
        {isBeginner && !beginnerNearFreeTier && (
          <span className="rounded-full bg-green-100 px-3 py-1 text-xs font-medium text-green-800">
            無料枠内
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
          <p className="font-semibold">
            ⚠ Beginner プランのファイルストレージ無料枠 (100MB) を超えました
          </p>
          <p className="mt-1">
            新規アップロードは停止しています (削除のみ可)。不要なファイルを削除すると自動的に再集計され、再びアップロード可能になります。反映されない場合は画面上部の{' '}
            <strong>[DB 容量 / API 利用量を再集計]</strong> ボタンをご利用ください。
          </p>
          <p className="mt-1 text-xs">
            または{' '}
            <a href="?tab=overview" className="font-semibold underline">
              Expert プランへアップグレード
            </a>{' '}
            すれば 50GB まで継続利用できます (¥10/GB tier、超過時のみ従量課金)。
          </p>
        </div>
      )}

      <dl className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div>
          <dt className="text-sm font-medium text-gray-500">現在の使用量</dt>
          <dd className="mt-1 text-2xl font-semibold text-gray-900">
            {formatBytes(typed.storageFileBytesUsed)}
          </dd>
          <p className="mt-1 text-xs text-gray-500">
            最新: {formatDateJa(typed.storageFileBytesUsedAt)}
          </p>
        </div>
        <div>
          <dt className="text-sm font-medium text-gray-500">月中ピーク (請求根拠)</dt>
          <dd className="mt-1 text-2xl font-semibold text-gray-900">
            {formatBytes(typed.storageFileBytesPeakThisMonth)}
          </dd>
          <p className="mt-1 text-xs text-gray-500">
            到達: {formatDateJa(typed.storageFileBytesPeakAt)}
          </p>
        </div>
        <div>
          <dt className="text-sm font-medium text-gray-500">想定請求額 (当月)</dt>
          <dd className="mt-1 text-2xl font-semibold text-gray-900">
            {formatJpy(estimatedJpy)}
          </dd>
          <p className="mt-1 text-xs text-gray-500">月末 cron で確定 (税抜)</p>
        </div>
      </dl>

      <div className="mt-6">
        <div className="mb-1 flex items-center justify-between text-xs text-gray-600">
          <span>0</span>
          <span>
            {isBeginner
              ? `Beginner 無料枠 ${BEGINNER_STORAGE_FREE_TIER_BYTES / SI_MB_BYTES}MB`
              : '50GB ハードキャップ'}{' '}
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
            aria-label={`使用率 ${usagePercent.toFixed(1)}%`}
          />
        </div>
      </div>

      <details className="mt-6 rounded border border-gray-200 bg-gray-50 p-4">
        <summary className="cursor-pointer text-sm font-medium text-gray-700">
          {isBeginner ? 'Beginner プランの容量ルールを表示' : '料金体系を表示'}
        </summary>
        <div className="mt-3 space-y-2 text-sm text-gray-600">
          {isBeginner ? (
            <>
              <p>
                <strong>無料枠:</strong> {BEGINNER_STORAGE_FREE_TIER_BYTES / SI_MB_BYTES}MB
                (Beginner プラン、PDF 10MB を 10 件アップロード可能の目安)
              </p>
              <p>
                <strong>ファイル上限:</strong> 1 ファイルあたり 50MB
              </p>
              <p>
                <strong>超過時の挙動:</strong> 新規アップロードが停止 (削除のみ可)、overage
                課金は<strong>発生しません</strong> (ADR-0025)
              </p>
              <p>
                <strong>削除後:</strong> 容量キャッシュが自動的に再集計され (debounce 30
                秒)、再びアップロード可能になります
              </p>
              <p className="text-xs text-gray-500">
                Expert / Pro プランへアップグレードすると 50GB まで継続利用可能 (¥10/GB
                tier、超過時のみ従量課金)。
              </p>
            </>
          ) : (
            <>
              <p>
                <strong>無料枠:</strong> {FILE_STORAGE_FREE_TIER_BYTES / SI_MB_BYTES}MB まで
                (PDF 10MB を 10 件無料の目安)
              </p>
              <p>
                <strong>超過料金:</strong> 1GB ごとに ¥10 (税抜、1MB 未満は繰上)
              </p>
              <p>
                <strong>ファイル上限:</strong> 1 ファイルあたり 50MB
              </p>
              <p className="text-xs text-gray-500">
                例: 200MB → ¥10 / 1GB → ¥10 / 1.5GB → ¥20 /{' '}
                {FILE_STORAGE_L1_USER_WARNING_BYTES / SI_GB_BYTES}GB → 表示通知 (Level 1) /{' '}
                {FILE_STORAGE_L2_ADMIN_ALERT_BYTES / SI_GB_BYTES}GB → 管理者通知 (Level 2) /{' '}
                {FILE_STORAGE_L3_HARD_CAP_BYTES / SI_GB_BYTES}GB → アップロード停止 (Level 3
                ハードキャップ)
              </p>
              <p className="text-xs text-gray-500">
                ハードキャップ到達時もダウンロード・削除は継続可能です。アップロードされたファイルは自動で検索インデックスが作成され、チャット検索や提案エンジンの対象になります (= 無料)。
              </p>
            </>
          )}
        </div>
      </details>
    </section>
  );
}
