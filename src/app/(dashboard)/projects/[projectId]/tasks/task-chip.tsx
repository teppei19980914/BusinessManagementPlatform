'use client';

import { memo } from 'react';
import { useTranslations } from 'next-intl';
import { Tooltip } from '@/components/ui/tooltip';
import { taskStatusColors } from '@/lib/task-tree-utils';
import { TASK_STATUSES } from '@/types';
import type { TaskDTO } from '@/services/task.service';

/**
 * WBS カンバンビュー用の付箋コンポーネント。
 *
 * 役割:
 *   担当者×暦日グリッドの各セルに積み上げて表示する。
 *   - 高さ: 日次工数（推定）に比例 (8h = FULL_HEIGHT_PX)
 *   - ホバー: ツールチップで総予定工数・WP名・期間・担当者・ステータスを表示
 *   - チェックボックス: 既存の一括操作 (selectedIds) と連動
 *   - クリック: 親が渡す onEditClick で既存編集ダイアログを開く
 *   - ドラッグ: draggable=true のとき cursor-grab でドラッグ開始可能
 *
 * 設計判断:
 *   - 最低高さ MIN_HEIGHT_PX を保証（工数0や未設定でも操作可能な高さを確保）
 *   - 高さは CSS inline style で計算 (Tailwind の任意値より安全)
 *   - ステータス色は既存の taskStatusColors を流用（DRY）
 */

/** 8h = この高さ (px)。日次工数に比例してスケールする */
const FULL_HEIGHT_PX = 200;

/** 最低高さ (px)。工数0 / 未設定でも表示可能にする */
const MIN_HEIGHT_PX = 32;

type Props = {
  task: TaskDTO;
  dailyEffort: number;
  isSelected: boolean;
  canSelectForProgress: boolean;
  onToggleSelect: (id: string) => void;
  onEditClick: (task: TaskDTO) => void;
  /** ドラッグ可能かどうか。canDragDrop=true かつ日付設定済みのときのみ true が渡る */
  draggable?: boolean;
  onDragStart?: (e: React.DragEvent<HTMLDivElement>) => void;
  /** ドラッグ中（自身がドラッグされている）かどうか。視覚的に薄く表示する */
  isDragging?: boolean;
};

function TaskChipImpl({
  task,
  dailyEffort,
  isSelected,
  canSelectForProgress,
  onToggleSelect,
  onEditClick,
  draggable = false,
  onDragStart,
  isDragging = false,
}: Props) {
  const t = useTranslations('wbs');

  const heightPx = Math.max(
    MIN_HEIGHT_PX,
    Math.round((dailyEffort / 8) * FULL_HEIGHT_PX),
  );

  const colorClass = taskStatusColors[task.status as keyof typeof taskStatusColors]
    ?? 'bg-muted border-muted-foreground/30';

  const statusLabel = TASK_STATUSES[task.status as keyof typeof TASK_STATUSES] ?? task.status;

  const tooltipContent = (
    <div className="space-y-1 text-xs">
      {task.parentTaskName && (
        <div>
          <span className="text-foreground/60">{t('kanbanTooltipWp')}: </span>
          <span className="font-medium">{task.parentTaskName}</span>
        </div>
      )}
      <div className="font-semibold">{task.name}</div>
      <div>
        <span className="text-foreground/60">{t('kanbanTooltipAssignee')}: </span>
        <span>{task.assigneeName ?? t('kanbanNoAssignee')}</span>
      </div>
      <div>
        <span className="text-foreground/60">{t('kanbanTooltipStatus')}: </span>
        <span>{statusLabel}</span>
      </div>
      {task.plannedStartDate && task.plannedEndDate && (
        <div>
          <span className="text-foreground/60">{t('kanbanTooltipPeriod')}: </span>
          <span>{t('kanbanPeriod', { start: task.plannedStartDate, end: task.plannedEndDate })}</span>
        </div>
      )}
      <div>
        <span className="text-foreground/60">{t('kanbanTooltipTotalEffort')}: </span>
        <span>{t('kanbanTotalEffort', { total: task.plannedEffort })}</span>
      </div>
      <div>
        <span className="text-foreground/60">{t('kanbanTooltipDailyEffort')}: </span>
        <span>{t('kanbanDailyEffort', { effort: dailyEffort })}</span>
      </div>
    </div>
  );

  return (
    <Tooltip content={tooltipContent} side="top" delay={200}>
      <div
        className={[
          'relative flex flex-col gap-0.5 rounded border px-1.5 py-1 text-xs overflow-hidden select-none transition-opacity hover:opacity-90',
          colorClass,
          draggable ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer',
          isDragging ? 'opacity-40' : '',
        ].join(' ')}
        style={{ height: `${heightPx}px` }}
        draggable={draggable}
        onDragStart={onDragStart}
        onClick={() => onEditClick(task)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onEditClick(task);
          }
        }}
        data-testid="kanban-task-chip"
        data-task-id={task.id}
      >
        {canSelectForProgress && (
          <input
            type="checkbox"
            checked={isSelected}
            onChange={(e) => {
              e.stopPropagation();
              onToggleSelect(task.id);
            }}
            onClick={(e) => e.stopPropagation()}
            className="absolute right-1 top-1 rounded"
            aria-label={task.name}
          />
        )}
        <span className="font-medium leading-tight line-clamp-2 pr-4">{task.name}</span>
        {heightPx >= 48 && (
          <span className="text-foreground/70 shrink-0">
            {t('kanbanDailyEffort', { effort: dailyEffort })}
          </span>
        )}
      </div>
    </Tooltip>
  );
}

export const TaskChip = memo(TaskChipImpl);
