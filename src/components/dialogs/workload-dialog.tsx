'use client';

/**
 * WorkloadDialog (2026-05-09 / PR H / #7)
 *
 * 担当者別 日次工数集計を表示するダイアログ。
 *   - GET /api/projects/[id]/tasks/workload で集計済データを取得
 *   - 担当者ごとに「期間総工数 + タスク数」をカードで、日次内訳をテーブルで表示
 *   - 1 日 8h 超の日は赤色、6-8h は黄色、それ未満は緑でハイライト (オーバーロード検知)
 *
 * 用途:
 *   PM/TL がメンバーの稼働を可視化し、過負荷を事前検知する。
 *   集計対象は activity (type='activity') のみ。集約 WP は子に按分されているため二重計上回避。
 */

import { useEffect, useMemo, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';

type DailyEntry = { date: string; effortHours: number };
type Row = {
  assigneeId: string;
  assigneeName: string;
  taskCount: number;
  totalEffortHours: number;
  daily: DailyEntry[];
};

type Props = {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function WorkloadDialog({ projectId, open, onOpenChange }: Props) {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // open=true の時だけ fetch (= 閉じている間は無駄な API 呼び出しを避ける)。
  // 外部 API 同期のため react-hooks/set-state-in-effect 警告例外規定の対象
  // (AttachmentList / CommentSection と同等の運用)。
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    // 外部 API 同期前のリセット (loading/error)。eslint 警告例外規定。
    /* eslint-disable react-hooks/set-state-in-effect */
    setLoading(true);
    setError('');
    /* eslint-enable react-hooks/set-state-in-effect */
    fetch(`/api/projects/${projectId}/tasks/workload`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((json) => {
        if (cancelled) return;
        setRows((json.data ?? []) as Row[]);
      })
      .catch(() => {
        if (cancelled) return;
        setError('工数集計の取得に失敗しました');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, projectId]);

  // 全担当者・全日付を 1 つのテーブルに統合表示するため、日付の集合を作る (昇順)
  const allDates = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) for (const d of r.daily) set.add(d.date);
    return Array.from(set).sort();
  }, [rows]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-[min(95vw,72rem)] max-h-[85vh] overflow-y-auto"
        title="担当者別 日次工数集計 (#7)"
      >
        <DialogHeader>
          <DialogTitle>工数集計 (担当者別 / 日次)</DialogTitle>
          <DialogDescription>
            Activity の予定工数を予定期間で按分し、担当者 × 日付で集計した結果を表示します。
            集約 WP は子に按分済のため二重計上されません。
          </DialogDescription>
        </DialogHeader>

        {loading && (
          <p className="py-8 text-center text-sm text-muted-foreground">読込中…</p>
        )}
        {error && (
          <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>
        )}

        {!loading && !error && rows.length === 0 && (
          <p className="py-8 text-center text-sm text-muted-foreground">
            集計可能な Activity がありません (担当者 + 予定開始日 + 予定終了日 + 予定工数すべてが必要)
          </p>
        )}

        {!loading && !error && rows.length > 0 && (
          <div className="space-y-4">
            {/* サマリ: 担当者ごとのカード */}
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {rows.map((r) => (
                <div
                  key={r.assigneeId}
                  className="rounded border p-3 text-sm cursor-help"
                  title={`期間総工数 ${r.totalEffortHours}h を ${r.daily.length} 日に按分。タスク ${r.taskCount} 件`}
                >
                  <p className="text-xs text-muted-foreground">担当者</p>
                  <p className="font-medium">{r.assigneeName}</p>
                  <div className="mt-1 flex items-baseline gap-3">
                    <span className="text-lg font-bold">{r.totalEffortHours}h</span>
                    <span className="text-xs text-muted-foreground">{r.taskCount} 件</span>
                  </div>
                </div>
              ))}
            </div>

            {/* 日次内訳テーブル: 担当者 × 日付 */}
            <div className="overflow-x-auto rounded border">
              <table className="w-full border-collapse text-xs">
                <thead className="sticky top-0 bg-muted">
                  <tr>
                    <th className="border-b p-2 text-left">担当者</th>
                    {allDates.map((d) => (
                      <th
                        key={d}
                        className="border-b p-2 text-right font-mono"
                        title={`日付: ${d}`}
                      >
                        {d.slice(5)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    // assignee の date → effort 早見表
                    const map = new Map(r.daily.map((e) => [e.date, e.effortHours]));
                    return (
                      <tr key={r.assigneeId} className="border-b last:border-b-0">
                        <td className="p-2 align-top font-medium">{r.assigneeName}</td>
                        {allDates.map((d) => {
                          const v = map.get(d) ?? 0;
                          if (v === 0) {
                            return <td key={d} className="p-2 text-right text-muted-foreground">-</td>;
                          }
                          // 1 日 8h 超は赤、6-8h は黄、それ未満は緑系
                          const tone =
                            v > 8
                              ? 'bg-destructive/15 text-destructive font-semibold'
                              : v >= 6
                                ? 'bg-amber-50 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300'
                                : 'bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-300';
                          return (
                            <td
                              key={d}
                              className={`p-2 text-right font-mono ${tone}`}
                              title={`${r.assigneeName} / ${d}: ${v}h`}
                            >
                              {v}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
              <span>凡例:</span>
              <Badge variant="outline" className="bg-emerald-50 dark:bg-emerald-900/20">
                ≦ 6h (適正)
              </Badge>
              <Badge variant="outline" className="bg-amber-50 dark:bg-amber-900/30">
                6-8h (要注意)
              </Badge>
              <Badge variant="destructive">{'> 8h (過負荷)'}</Badge>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
