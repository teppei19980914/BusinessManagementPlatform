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
 *   - 4 層防御 Level バッジ (none / L1 1GB / L2 10GB / L3 50GB)
 *   - 無料枠 50MB / ハードキャップ 50GB の説明
 *
 * 関連:
 *   - ADR: docs/adr/0020-db-capacity-usage-based-billing.md
 *   - 計算: src/config/db-capacity-pricing.ts
 *   - 親: src/app/(dashboard)/settings/tenant/page.tsx
 */

import { prisma } from '@/lib/db';
import {
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

const LEVEL_BADGES: Record<DbCapacityWarningLevel, { label: string; color: string }> = {
  none: { label: '正常', color: 'bg-green-100 text-green-800' },
  l1: { label: 'Level 1 (1GB 到達)', color: 'bg-blue-100 text-blue-800' },
  l2: { label: 'Level 2 (10GB 到達)', color: 'bg-yellow-100 text-yellow-800' },
  l3: { label: 'Level 3 (50GB / ハードキャップ到達)', color: 'bg-red-100 text-red-800' },
};

export async function DbCapacitySection({ tenantId }: { tenantId: string }) {
  const data = await prisma.tenant.findFirst({
    where: { id: tenantId, deletedAt: null },
    select: {
      storageBytesUsed: true,
      storageBytesPeakThisMonth: true,
      storageBytesUsedAt: true,
      storageBytesPeakAt: true,
      dbCapacityWarningLevel: true,
    },
  });
  if (!data) return null;

  const typed = data as DbCapacityData;

  // 課金額算出 (= 月末確定額の見通し)
  const estimatedJpy = calculateOverageJpy(typed.storageBytesPeakThisMonth);
  // 現在値で classify (= 表示用の現状ステータス)
  const currentLevel = classifyDbCapacityLevel(typed.storageBytesPeakThisMonth);
  const safeLevel: DbCapacityWarningLevel =
    currentLevel in LEVEL_BADGES ? currentLevel : 'none';
  const badge = LEVEL_BADGES[safeLevel];

  // 進捗率 (50GB ハードキャップに対する使用率)
  const usagePercent = Math.min(
    100,
    (Number(typed.storageBytesPeakThisMonth) / DB_CAPACITY_L3_HARD_CAP_BYTES) * 100,
  );

  return (
    <section
      className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm"
      aria-labelledby="db-capacity-section-title"
    >
      <div className="mb-4 flex items-center justify-between">
        <h2
          id="db-capacity-section-title"
          className="text-lg font-semibold text-gray-900"
        >
          DB 容量 (従量課金)
        </h2>
        <span className={`rounded-full px-3 py-1 text-xs font-medium ${badge.color}`}>
          {badge.label}
        </span>
      </div>

      {/* 主要数値 */}
      <dl className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div>
          <dt className="text-sm font-medium text-gray-500">現在の使用量</dt>
          <dd className="mt-1 text-2xl font-semibold text-gray-900">
            {formatBytes(typed.storageBytesUsed)}
          </dd>
          <p className="mt-1 text-xs text-gray-500">
            最新: {formatDateJa(typed.storageBytesUsedAt)}
          </p>
        </div>
        <div>
          <dt className="text-sm font-medium text-gray-500">月中ピーク (請求根拠)</dt>
          <dd className="mt-1 text-2xl font-semibold text-gray-900">
            {formatBytes(typed.storageBytesPeakThisMonth)}
          </dd>
          <p className="mt-1 text-xs text-gray-500">
            到達: {formatDateJa(typed.storageBytesPeakAt)}
          </p>
        </div>
        <div>
          <dt className="text-sm font-medium text-gray-500">想定請求額 (当月)</dt>
          <dd className="mt-1 text-2xl font-semibold text-gray-900">
            {formatJpy(estimatedJpy)}
          </dd>
          <p className="mt-1 text-xs text-gray-500">
            月末 cron で確定 (税抜)
          </p>
        </div>
      </dl>

      {/* 進捗バー (50GB ハードキャップに対する使用率) */}
      <div className="mt-6">
        <div className="mb-1 flex items-center justify-between text-xs text-gray-600">
          <span>0</span>
          <span>50GB ハードキャップ ({usagePercent.toFixed(1)}%)</span>
        </div>
        <div className="h-2 w-full overflow-hidden rounded-full bg-gray-200">
          <div
            className={`h-full transition-all ${
              safeLevel === 'l3'
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

      {/* 料金体系の説明 */}
      <details className="mt-6 rounded border border-gray-200 bg-gray-50 p-4">
        <summary className="cursor-pointer text-sm font-medium text-gray-700">
          料金体系を表示
        </summary>
        <div className="mt-3 space-y-2 text-sm text-gray-600">
          <p>
            <strong>無料枠:</strong> {DB_CAPACITY_FREE_TIER_BYTES / SI_MB_BYTES}MB まで
          </p>
          <p>
            <strong>超過料金:</strong> 1GB ごとに ¥50 (税抜、1MB 未満は繰上)
          </p>
          <p className="text-xs text-gray-500">
            例: 100MB → ¥50 / 1GB → ¥50 / 1.5GB → ¥100 /{' '}
            {DB_CAPACITY_L1_USER_WARNING_BYTES / SI_GB_BYTES}GB → 月通知あり (Level 1) /{' '}
            {DB_CAPACITY_L2_ADMIN_ALERT_BYTES / SI_GB_BYTES}GB → 管理者通知 (Level 2) /{' '}
            {DB_CAPACITY_L3_HARD_CAP_BYTES / SI_GB_BYTES}GB → 書込停止 (Level 3
            ハードキャップ)
          </p>
          <p className="text-xs text-gray-500">
            ハードキャップ到達時もデータの読み取り・エクスポートは継続可能です。
          </p>
        </div>
      </details>
    </section>
  );
}
