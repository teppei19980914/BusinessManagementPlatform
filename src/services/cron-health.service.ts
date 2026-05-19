/**
 * cron 健全性検知サービス (PR-V8 / 2026-05-19)
 *
 * 役割:
 *   `cron_execution_logs` の最終成功実行 vs `CRON_JOBS[name].expectedMaxGapHours` を比較し、
 *   「期待されているのに長期間動いていない cron」を検知する。
 *
 *   既存の `admin-alert.service.ts:detectAndAlertCronFailures` は **`status='failure'` な
 *   実行を検知** するが、cron-job.org に登録されていない / endpoint が間違っている等で
 *   「そもそも cron_execution_logs に行が作られない」ケース (本件: tenant-monthly-reset 未登録)
 *   は検知できない。本 service はそのギャップを埋める。
 *
 * 設計判断:
 *   - **CRON_JOBS が真実源**: 期待スケジュールの定義は `src/config/cron-jobs.ts` 1 箇所に集約。
 *     `expectedMaxGapHours` をここで宣言し、本 service がそれを参照する。
 *   - **「最後の成功実行が記録なし」も検知**: 初回起動前 / DB 消失等で記録ゼロの場合も
 *     `staleness='never_recorded'` として警告対象に含める。
 *   - **alert 機構には依存しない**: メール送信は呼出側 (diagnostics page / cron) の責務。
 *     本 service は純粋に「健全性データ」を計算して返すだけ。
 *
 * 関連:
 *   - 期待スケジュール定義: src/config/cron-jobs.ts CRON_JOBS
 *   - 既存 cron 失敗 alert: src/services/admin-alert.service.ts detectAndAlertCronFailures
 *   - 診断ダッシュボード表示: src/app/(dashboard)/admin/super/diagnostics/page.tsx
 *   - 本件 root cause: cron-job.org に tenant-monthly-reset 未登録だった (運用問題)
 */

import { prisma } from '@/lib/db';
import { CRON_JOBS, type CronJobMetadata } from '@/config/cron-jobs';

/** cron 健全性の状態。 */
export type CronHealthStatus =
  /** 期待ギャップ以内に最後の成功実行あり (= 正常) */
  | 'healthy'
  /** 最後の成功実行が期待ギャップを超過 (= 長期停止) */
  | 'stale'
  /** cron_execution_logs に記録ゼロ (= 未登録 or 初回起動前) */
  | 'never_recorded';

export type CronHealthRow = {
  cronName: string;
  metadata: CronJobMetadata;
  status: CronHealthStatus;
  /** 最後の成功実行時刻 (記録なしなら null) */
  lastSuccessAt: Date | null;
  /** 最後の失敗実行時刻 (記録なしなら null) */
  lastFailureAt: Date | null;
  /** 最後の成功実行から経過した時間 (時間単位)。記録なしなら null。 */
  hoursSinceLastSuccess: number | null;
  /** stale / never_recorded の場合に true (= 診断ダッシュボードで強調表示) */
  isUnhealthy: boolean;
};

/**
 * 単一の cron の健全性を検査する。
 *
 * @param cronName CRON_JOBS の key と一致する文字列
 * @param now 検査時刻 (デフォルト現在、テスト容易性のため引数化)
 * @returns 該当 cron の健全性レコード。CRON_JOBS に未登録なら null。
 */
export async function checkCronHealth(
  cronName: string,
  now: Date = new Date(),
): Promise<CronHealthRow | null> {
  const metadata = CRON_JOBS[cronName];
  if (!metadata) return null;

  const [lastSuccess, lastFailure] = await Promise.all([
    prisma.cronExecutionLog.findFirst({
      where: { cronName, status: 'success' },
      orderBy: { startedAt: 'desc' },
      select: { startedAt: true },
    }),
    prisma.cronExecutionLog.findFirst({
      where: { cronName, status: 'failure' },
      orderBy: { startedAt: 'desc' },
      select: { startedAt: true },
    }),
  ]);

  const lastSuccessAt = lastSuccess?.startedAt ?? null;
  const lastFailureAt = lastFailure?.startedAt ?? null;

  let status: CronHealthStatus;
  let hoursSinceLastSuccess: number | null;
  if (lastSuccessAt == null) {
    status = 'never_recorded';
    hoursSinceLastSuccess = null;
  } else {
    hoursSinceLastSuccess =
      (now.getTime() - lastSuccessAt.getTime()) / (60 * 60 * 1000);
    status =
      hoursSinceLastSuccess > metadata.expectedMaxGapHours ? 'stale' : 'healthy';
  }

  return {
    cronName,
    metadata,
    status,
    lastSuccessAt,
    lastFailureAt,
    hoursSinceLastSuccess,
    isUnhealthy: status !== 'healthy',
  };
}

/**
 * 全 cron (CRON_JOBS に登録されている全 key) の健全性を一括検査する。
 *
 * 診断ダッシュボードの「cron 健全性セクション」で利用する。
 * 結果は `isUnhealthy` (= stale or never_recorded) を先頭に、その後 healthy を並べる。
 *
 * @param now 検査時刻 (デフォルト現在)
 * @returns 各 cron の健全性レコード配列
 */
export async function checkAllCronHealth(
  now: Date = new Date(),
): Promise<CronHealthRow[]> {
  const names = Object.keys(CRON_JOBS);
  const results = await Promise.all(names.map((n) => checkCronHealth(n, now)));
  const rows = results.filter((r): r is CronHealthRow => r !== null);
  // 異常を先頭に、その後成功時刻 (古い順 = より問題に近い順)
  return rows.sort((a, b) => {
    if (a.isUnhealthy && !b.isUnhealthy) return -1;
    if (!a.isUnhealthy && b.isUnhealthy) return 1;
    // 同分類内: 経過時間が大きい (より長く動いていない) ほど先頭
    const aTime = a.hoursSinceLastSuccess ?? Number.POSITIVE_INFINITY;
    const bTime = b.hoursSinceLastSuccess ?? Number.POSITIVE_INFINITY;
    return bTime - aTime;
  });
}

/**
 * 異常な cron (stale + never_recorded) のみを返す軽量版。
 *
 * /admin/super top の赤バナーや件数表示に使う。
 */
export async function listUnhealthyCrons(
  now: Date = new Date(),
): Promise<CronHealthRow[]> {
  const all = await checkAllCronHealth(now);
  return all.filter((r) => r.isUnhealthy);
}
