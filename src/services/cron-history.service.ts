/**
 * cron 実行履歴の集計サービス (PR feat/cron-execution-log / 2026-05-18)
 *
 * 役割:
 *   `cron_execution_logs` から super_admin UI 表示用にデータを抽出し、
 *   サマリ集計 + stale running 判定を済ませた形で返す。
 *
 * 設計判断:
 *   - **render 中の `Date.now()` を回避**: server component (page.tsx) は React Compiler の
 *     purity ルールに準拠する必要があるため、時刻依存の集計はサービス層に閉じ込める
 *   - **prisma を呼ぶ層で集計 + 判定を完結**: page は受け取った値をそのまま描画するだけにする
 *     (= ロジックが service に集約されレビューしやすい)
 *
 * 関連:
 *   - DB model: prisma/schema.prisma model CronExecutionLog
 *   - UI: src/app/(dashboard)/admin/super/cron-history/page.tsx
 *   - KDD: docs/knowledge/KDD_PATTERNS.md §5.X+72
 */

import { prisma } from '@/lib/db';

/**
 * stale running 判定の閾値: Netlify Functions 10s 上限 + 余裕 → 30 秒。
 * 30 秒以上 running のまま残っているレコードは Lambda timeout で終了 update が走らなかった
 * 可能性が高い (= 監視すべき状態)。
 */
export const STALE_RUNNING_THRESHOLD_MS = 30_000;

export type CronHistoryEntry = {
  id: string;
  cronName: string;
  startedAt: Date;
  completedAt: Date | null;
  durationMs: number | null;
  status: string;
  errorMessage: string | null;
  invokerIp: string | null;
  isStaleRunning: boolean;
};

export type CronHistorySummary = {
  total: number;
  success: number;
  failure: number;
  running: number;
  /** running のまま 30 秒以上経過したレコード数 (= timeout 疑い件数) */
  staleRunning: number;
};

export type CronHistoryView = {
  summary: CronHistorySummary;
  history: CronHistoryEntry[];
};

/**
 * super_admin の cron 履歴ページ向けに、サマリ + 直近 N 件の実行履歴を返す。
 *
 * @param historyLimit 履歴テーブルの最大表示件数 (default 100)
 */
export async function fetchCronHistoryView(historyLimit = 100): Promise<CronHistoryView> {
  // 直近 24h の境界 + stale 判定の閾値を service 内で計算 (= page render では時刻計算を行わない)
  const nowMs = Date.now();
  const since24h = new Date(nowMs - 24 * 60 * 60 * 1000);

  const [recent24h, rawHistory] = await Promise.all([
    prisma.cronExecutionLog.findMany({
      where: { startedAt: { gte: since24h } },
      select: { status: true, startedAt: true },
    }),
    prisma.cronExecutionLog.findMany({
      orderBy: { startedAt: 'desc' },
      take: historyLimit,
      select: {
        id: true,
        cronName: true,
        startedAt: true,
        completedAt: true,
        durationMs: true,
        status: true,
        errorMessage: true,
        invokerIp: true,
      },
    }),
  ]);

  const summary: CronHistorySummary = {
    total: recent24h.length,
    success: recent24h.filter((r) => r.status === 'success').length,
    failure: recent24h.filter((r) => r.status === 'failure').length,
    running: recent24h.filter((r) => r.status === 'running').length,
    staleRunning: recent24h.filter(
      (r) => r.status === 'running' && nowMs - r.startedAt.getTime() > STALE_RUNNING_THRESHOLD_MS,
    ).length,
  };

  const history: CronHistoryEntry[] = rawHistory.map((e) => ({
    ...e,
    isStaleRunning:
      e.status === 'running' && nowMs - e.startedAt.getTime() > STALE_RUNNING_THRESHOLD_MS,
  }));

  return { summary, history };
}
