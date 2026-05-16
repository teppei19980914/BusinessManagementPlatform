/**
 * /admin/super/cron-history (PR feat/cron-execution-log / 2026-05-18)
 *
 * super_admin 向け cron 実行履歴ダッシュボード。
 *
 * 目的:
 *   - cron-job.org の外部ダッシュボードに頼らず、社内で完結した監視導線
 *   - Netlify Functions 10 秒 timeout の検知 (= isStaleRunning フラグで警告表示)
 *   - 失敗の根本原因追跡 (errorMessage を直接表示)
 *
 * 認可: layout.tsx (super_admin guard) で担保。本ページ自体は再チェック不要。
 *
 * UI 要素:
 *   1. 概要パネル: 直近 24h の成功 / 失敗 / running 件数集計
 *   2. cron 説明テーブル: 全 cron の動作概要 (CRON_JOBS から)
 *   3. 実行履歴テーブル: 直近 100 件、status バッジ + duration + stale running 警告
 *
 * データ取得: server component で prisma 直接読み (= API ルート経由不要、SSR で完結)
 */

import { fetchCronHistoryView, STALE_RUNNING_THRESHOLD_MS } from '@/services/cron-history.service';
import { CRON_JOBS, getCronDescription } from '@/config/cron-jobs';

const HISTORY_LIMIT = 100;

export default async function CronHistoryPage() {
  // Date.now() は render 中に呼べない (react-hooks/purity)。service 側で計算して受け取る。
  const { summary, history } = await fetchCronHistoryView(HISTORY_LIMIT);

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">cron 実行履歴</h1>

      {/* 直近 24h サマリ */}
      <section className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <SummaryCard label="直近 24h 実行" value={summary.total} />
        <SummaryCard label="成功" value={summary.success} tone="success" />
        <SummaryCard label="失敗" value={summary.failure} tone={summary.failure > 0 ? 'error' : 'neutral'} />
        <SummaryCard label="実行中" value={summary.running} tone="neutral" />
        <SummaryCard
          label="stale (timeout 疑い)"
          value={summary.staleRunning}
          tone={summary.staleRunning > 0 ? 'error' : 'neutral'}
        />
      </section>

      {summary.staleRunning > 0 && (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm">
          <strong>⚠ timeout 疑い:</strong> status=&apos;running&apos; のまま 30 秒以上経過した実行が
          {' '}{summary.staleRunning} 件あります。Netlify Functions の 10 秒制限を超過した可能性が高いため、
          該当 cron の処理を chunk 化 / async 化する対応を検討してください。
        </div>
      )}

      {/* cron 動作概要 */}
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">登録 cron 一覧</h2>
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="bg-muted">
              <tr>
                <th className="px-3 py-2 text-left">cron 名</th>
                <th className="px-3 py-2 text-left">動作概要</th>
                <th className="px-3 py-2 text-left">スケジュール</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(CRON_JOBS).map(([name, meta]) => (
                <tr key={name} className="border-t">
                  <td className="px-3 py-2 font-mono text-xs">{name}</td>
                  <td className="px-3 py-2 text-xs leading-relaxed">{meta.description}</td>
                  <td className="px-3 py-2 text-xs whitespace-nowrap">{meta.schedule}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* 実行履歴 */}
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">直近 {HISTORY_LIMIT} 件の実行履歴</h2>
        {history.length === 0 ? (
          <p className="text-sm text-muted-foreground">まだ実行履歴がありません。</p>
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead className="bg-muted">
                <tr>
                  <th className="px-3 py-2 text-left">開始時刻</th>
                  <th className="px-3 py-2 text-left">cron 名</th>
                  <th className="px-3 py-2 text-left">動作</th>
                  <th className="px-3 py-2 text-left">所要</th>
                  <th className="px-3 py-2 text-left">状態</th>
                  <th className="px-3 py-2 text-left">詳細</th>
                </tr>
              </thead>
              <tbody>
                {history.map((entry) => {
                  const isStale = entry.isStaleRunning;
                  return (
                    <tr key={entry.id} className={`border-t ${isStale ? 'bg-destructive/5' : ''}`}>
                      <td className="px-3 py-2 whitespace-nowrap text-xs">
                        {formatDateTime(entry.startedAt)}
                      </td>
                      <td className="px-3 py-2 font-mono text-xs">{entry.cronName}</td>
                      <td className="px-3 py-2 text-xs">
                        <span title={getCronDescription(entry.cronName)} className="text-muted-foreground">
                          {truncate(getCronDescription(entry.cronName), 40)}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-xs whitespace-nowrap">
                        {entry.durationMs != null ? `${entry.durationMs} ms` : '—'}
                      </td>
                      <td className="px-3 py-2 text-xs">
                        <StatusBadge status={entry.status} isStale={isStale} />
                      </td>
                      <td className="px-3 py-2 text-xs">
                        {entry.errorMessage && (
                          <details>
                            <summary className="cursor-pointer text-destructive">エラー</summary>
                            <pre className="mt-1 whitespace-pre-wrap break-all rounded bg-muted p-2 text-[11px]">
                              {entry.errorMessage}
                            </pre>
                          </details>
                        )}
                        {entry.invokerIp && (
                          <span className="ml-2 text-muted-foreground">IP: {entry.invokerIp}</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function SummaryCard({
  label,
  value,
  tone = 'neutral',
}: {
  label: string;
  value: number;
  tone?: 'success' | 'error' | 'neutral';
}) {
  const toneClass
    = tone === 'success'
      ? 'border-success/30 bg-success/5'
      : tone === 'error'
        ? 'border-destructive/30 bg-destructive/5'
        : 'border-input';
  return (
    <div className={`rounded-md border p-3 ${toneClass}`}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function StatusBadge({ status, isStale }: { status: string; isStale: boolean }) {
  if (isStale) {
    return (
      <span className="rounded-md bg-destructive px-2 py-0.5 text-xs font-medium text-destructive-foreground">
        running (stale)
      </span>
    );
  }
  if (status === 'success') {
    return (
      <span className="rounded-md bg-success/20 px-2 py-0.5 text-xs font-medium text-success">
        ✓ success
      </span>
    );
  }
  if (status === 'failure') {
    return (
      <span className="rounded-md bg-destructive/20 px-2 py-0.5 text-xs font-medium text-destructive">
        ✗ failure
      </span>
    );
  }
  return (
    <span className="rounded-md bg-info/20 px-2 py-0.5 text-xs font-medium text-info">
      ⋯ running
    </span>
  );
}

function formatDateTime(d: Date): string {
  // 監視画面なので JST 固定で表示 (テナント TZ は監視対象外、運用者向けの時刻を一意化)
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(d);
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}
