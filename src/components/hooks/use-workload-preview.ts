'use client';

/**
 * useWorkloadPreview (PR #361 / 2026-05-14)
 *
 * WBS の ACT 作成・編集 dialog で、入力中の (担当者 / 開始日 / 終了日 / 工数) から
 * 「合算した日次最大工数」をリアルタイム取得する React Hook。
 *
 * 動作:
 *   - 4 つの必須引数が揃ったら 300ms debounce で API GET 呼出
 *   - 揃わない / enabled=false なら API を呼ばず data=null
 *   - 入力が再変更されたら前回 fetch を AbortController でキャンセル
 *
 * 設計判断:
 *   - debounce 300ms: 既存 comment-section (250ms) と同オーダー。連打 API 呼出抑制
 *   - enabled flag: PM/TL ロール以外で false にして UI 側で表示制御
 *   - AbortController: 連続入力で古い fetch が後勝ちにならないようにする
 *
 * 関連:
 *   - API: GET /api/projects/[projectId]/tasks/workload/preview
 *   - サービス: src/services/task.service.ts:previewActivityWorkload
 *   - UI: src/components/wbs/workload-preview-line.tsx
 */

import { useEffect, useState } from 'react';
import type { WorkloadLevel } from '@/config/workload';

export type WorkloadPreviewData = {
  maxDailyEffort: number;
  maxDailyDate: string | null;
  level: WorkloadLevel;
};

export type UseWorkloadPreviewArgs = {
  projectId: string;
  assigneeId: string;
  startDate: string;
  endDate: string;
  plannedEffort: number;
  excludeTaskId?: string;
  /** true=土日祝日を稼働日に含む、false=平日のみ（デフォルト: false） */
  includeWeekends: boolean;
  /** false なら fetch せず data=null (PM/TL ロール以外で false にして表示抑制) */
  enabled: boolean;
};

/** 必須 4 引数が揃っているか (空文字 / 0 効果は OK だが NaN や負値は除外) */
function isInputComplete(args: UseWorkloadPreviewArgs): boolean {
  if (!args.enabled) return false;
  if (!args.projectId || !args.assigneeId) return false;
  if (!args.startDate || !args.endDate) return false;
  if (Number.isNaN(args.plannedEffort) || args.plannedEffort < 0) return false;
  return true;
}

export function useWorkloadPreview(args: UseWorkloadPreviewArgs): {
  data: WorkloadPreviewData | null;
  isLoading: boolean;
} {
  const [data, setData] = useState<WorkloadPreviewData | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!isInputComplete(args)) {
      // 入力が不完全になったら表示をクリア。effect 内 setState は通常避けるが、
      // 「入力欄が空になった瞬間に古い preview を消す」UX のため必要。
      // eslint-disable-next-line react-hooks/set-state-in-effect -- 入力不完全時の表示リセット
      setData(null);
      setIsLoading(false);
      return;
    }

    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setIsLoading(true);
      try {
        const qs = new URLSearchParams({
          assigneeId: args.assigneeId,
          startDate: args.startDate,
          endDate: args.endDate,
          plannedEffort: String(args.plannedEffort),
        });
        if (args.excludeTaskId) qs.set('excludeTaskId', args.excludeTaskId);
        qs.set('includeWeekends', String(args.includeWeekends));
        const res = await fetch(
          `/api/projects/${args.projectId}/tasks/workload/preview?${qs.toString()}`,
          { signal: controller.signal },
        );
        if (!res.ok) {
          setData(null);
          return;
        }
        const json = (await res.json()) as { data: WorkloadPreviewData };
        setData(json.data);
      } catch (e) {
        if ((e as Error).name === 'AbortError') return; // キャンセルは無視
        setData(null);
      } finally {
        setIsLoading(false);
      }
    }, 300);

    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- args の各フィールドを個別 deps に展開
  }, [
    args.projectId,
    args.assigneeId,
    args.startDate,
    args.endDate,
    args.plannedEffort,
    args.excludeTaskId,
    args.includeWeekends,
    args.enabled,
  ]);

  return { data, isLoading };
}
