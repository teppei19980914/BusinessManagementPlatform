'use client';

/**
 * WBS 管理画面 (本プロダクトで最複雑のクライアントコンポーネント)。
 *
 * 役割:
 *   プロジェクトのタスク階層 (WP/ACT) の表示と編集。
 *   - 階層ツリー表示 (折りたたみ可)
 *   - 個別編集ダイアログ (WP / ACT 別フォーム)
 *   - 一括選択 + 一括編集パネル (担当者・期限・ステータス・実績の bulk 更新)
 *   - 進捗ログ追記
 *   - WBS テンプレート CSV インポート / エクスポート
 *
 * パフォーマンス対策 (PR #25):
 *   - TaskTreeNode を React.memo 化。props 参照安定のため useCallback / useMemo を多用
 *   - 行 × 列の背景画像描画を共通化 (重複生成回避)
 *
 * ステータス整合性 (PR #69):
 *   - 進捗 100% ↔ ステータス完了の双方向強制 (UI と API 両層で実装)
 *   - 詳細は task.service.ts の updateTask / updateTaskProgress 参照
 *
 * 認可: canEdit prop (PM/TL 以上 or admin) で編集系ボタンの表示制御。
 * API: /api/projects/[id]/tasks (一覧/作成), /api/projects/[id]/tasks/[taskId] (編集/削除),
 *      /api/projects/[id]/tasks/bulk-update, /api/projects/[id]/tasks/[taskId]/progress
 *
 * 関連:
 *   - SPECIFICATION.md (WBS 管理画面)
 *   - DESIGN.md §15 (idx_tasks_gantt 等のインデックス) / §17 (パフォーマンス要件)
 */

import { memo, useCallback, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useLoading } from '@/components/loading-overlay';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { NumberInput } from '@/components/ui/number-input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Pencil, Trash2 } from 'lucide-react';
import {
  collectAllIds,
  collectSelfAndDescendantIds,
  filterTreeByAssignee,
  filterTreeByStatus,
  taskStatusColors,
  UNASSIGNED_KEY,
} from '@/lib/task-tree-utils';
import { nativeSelectClass } from '@/components/ui/native-select-style';
import { TASK_STATUSES, WBS_TYPES } from '@/types';
import { AttachmentList } from '@/components/attachments/attachment-list';
// feat/wbs-overwrite-import: WBS 上書きインポート (Sync by ID) ダイアログ
import { WbsSyncImportDialog } from '@/components/dialogs/wbs-sync-import-dialog';
import {
  StagedAttachmentsInput,
  persistStagedAttachments,
  type StagedAttachment,
} from '@/components/attachments/staged-attachments-input';
// PR #168: WBS 一覧で添付を表示するためのバッチ取得 + Cell コンポーネント
import { useBatchAttachments } from '@/components/attachments/use-batch-attachments';
import { AttachmentsCell } from '@/components/attachments/attachments-cell';
import type { AttachmentDTO } from '@/services/attachment.service';
import {
  ResizableColumnsProvider,
  ResizableHead,
  ResetColumnsButton,
} from '@/components/ui/resizable-columns';
import { DateFieldWithActions } from '@/components/ui/date-field-with-actions';
import type { TaskDTO } from '@/services/task.service';
import type { MemberDTO } from '@/services/member.service';
import { useSessionStringSet } from '@/lib/use-session-state';
import { MultiSelectFilter } from '@/components/multi-select-filter';
// feat/gantt-tab-restructure (PR-C item 6): Gantt 表示は専用タブから WBS タブ内のトグルへ移行
import { GanttClient } from '../gantt/gantt-client';

const ALL_STATUS_KEYS = Object.keys(TASK_STATUSES) as Array<keyof typeof TASK_STATUSES>;

type Props = {
  projectId: string;
  tasks: TaskDTO[];
  members: MemberDTO[];
  projectRole: string | null;
  systemRole: string;
  userId: string;
  /**
   * CRUD 後に呼び出すデータ再取得ハンドラ。
   * 親コンポーネントが保持する lazy fetch の state を再フェッチするために使う。
   * 未指定時は従来の router.refresh() フォールバック（後方互換）。
   */
  onReload?: () => Promise<void> | void;
};

// 旧ローカル statusColors は lib/task-tree-utils.ts の taskStatusColors に集約 (PR #63 DRY)
const statusColors = taskStatusColors;

/**
 * 一括更新ダイアログ内で「この項目を適用するか」のチェックボックス付きフィールド行。
 * apply が true のときだけ入力が有効・サーバへ送信対象になる。
 */
function ApplyFieldRow({
  apply,
  onApplyChange,
  label,
  children,
}: {
  apply: boolean;
  onApplyChange: (next: boolean) => void;
  label: string;
  children: React.ReactNode;
}) {
  const t = useTranslations('wbs');
  return (
    <div className="flex items-start gap-2">
      <input
        type="checkbox"
        checked={apply}
        onChange={(e) => onApplyChange(e.target.checked)}
        className="mt-2 rounded"
        aria-label={t('bulkApplyToggleAria', { label })}
      />
      <div className="flex-1 space-y-1">
        <Label className={apply ? 'text-sm' : 'text-sm text-muted-foreground'}>{label}</Label>
        <div className={apply ? '' : 'pointer-events-none opacity-50'}>{children}</div>
      </div>
    </div>
  );
}

type TaskTreeNodeProps = {
  task: TaskDTO;
  depth: number;
  canEditPmTl: boolean;
  /** PR #87: 一括選択チェックボックスを表示してよいか (pm_tl または member ロール) */
  canSelectForProgress: boolean;
  userId: string;
  projectId: string;
  reload: () => Promise<void> | void;
  onLoading: <T>(fn: () => Promise<T>) => Promise<T>;
  isSelected: boolean;
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  members: MemberDTO[];
  parentOptions: { id: string; label: string }[];
  /** 編集アイコンクリック時に親 (TasksClient) の編集ダイアログを開くコールバック */
  onEditClick: (task: TaskDTO) => void;
  /** PR #61: WP の展開状態 (Set に含まれる ID は展開、含まれなければ折りたたみ) */
  expandedTaskIds: Set<string>;
  /** PR #61: WP 展開トグル。子に伝播する */
  onToggleExpanded: (taskId: string) => void;
  /** feat/wbs-overwrite-import: ID 列を表示するか (CSV 整合確認用) */
  showIdColumn: boolean;
  /** PR #168: バッチ取得した添付 (entityId → AttachmentDTO 配列)。一覧の添付列で表示する */
  attachmentsByEntity: Record<string, AttachmentDTO[]>;
};

function TaskTreeNodeImpl({
  task,
  depth,
  canEditPmTl,
  canSelectForProgress,
  userId,
  projectId,
  reload,
  onLoading,
  isSelected,
  selectedIds,
  onToggleSelect,
  members,
  parentOptions,
  onEditClick,
  expandedTaskIds,
  onToggleExpanded,
  showIdColumn,
  attachmentsByEntity,
}: TaskTreeNodeProps) {
  // 表示値は task prop を直接参照する。
  // 従来あったローカル display state（即時反映用）は、編集ダイアログ化に伴い廃止。
  // CRUD 後の reload + stale-while-revalidate（PR #33）で UI が追従する。
  const t = useTranslations('wbs');
  const unsetLabel = t('unsetShort');

  const isWP = task.type === 'work_package';
  const hasChildren = task.children && task.children.length > 0;
  // PR #61: 折りたたみ状態を親から受け取る (sessionStorage 永続化)。
  // 対象は WP かつ子を持つノードのみ。デフォルトは「折りたたみ」(Set に含まれない)。
  const isCollapsed = isWP && hasChildren ? !expandedTaskIds.has(task.id) : false;
  const isAssignee = task.assigneeId === userId;
  // メンバー編集: 担当者のみ（ACT限定）
  const canMemberEdit = !isWP && isAssignee;
  const canOpenEdit = canEditPmTl || canMemberEdit;
  // 予定期間 / 実績期間の表示テキスト（片方しかない場合は unsetLabel を反対側に挿入）
  const plannedRangeText = (() => {
    if (!task.plannedStartDate && !task.plannedEndDate) return '-';
    return `${task.plannedStartDate || unsetLabel} 〜 ${task.plannedEndDate || unsetLabel}`;
  })();
  const actualRangeText = (() => {
    if (!task.actualStartDate && !task.actualEndDate) return '-';
    return `${task.actualStartDate || unsetLabel} 〜 ${task.actualEndDate || unsetLabel}`;
  })();
  // 進捗&工数の表示: ACT は 進捗% / 工数h、WP は進捗%のみ（工数は子から集計済を表示）
  const effortText = task.plannedEffort > 0 ? `${task.plannedEffort}h` : null;
  void parentOptions;
  void members;

  return (
    <>
      <tr className={`border-b hover:bg-muted ${isWP ? 'bg-muted/50' : ''}`}>
        {canSelectForProgress && (
          // PR #87: member ロールも自分担当タスクの実績系一括更新ができるようチェックボックスを表示。
          // 選択チェック時は全行表示 (member が自分担当以外を間違って選択してもサーバ側で 403 で弾かれる)。
          <td className="px-1.5 py-1.5 md:px-2 md:py-2 w-8">
            <input type="checkbox" checked={isSelected} onChange={() => onToggleSelect(task.id)} className="rounded" />
          </td>
        )}
        {/* feat/wbs-overwrite-import: ID 列 (CSV 整合確認用、トグル ON のときのみ) */}
        {showIdColumn && (
          <td className="px-1.5 py-1.5 md:px-2 md:py-2 font-mono text-xs text-muted-foreground">
            <code
              className="cursor-pointer hover:text-foreground"
              onClick={(e) => {
                const r = document.createRange();
                r.selectNodeContents(e.currentTarget);
                window.getSelection()?.removeAllRanges();
                window.getSelection()?.addRange(r);
              }}
              title={t('idCopyHint')}
            >
              {task.id}
            </code>
          </td>
        )}
        <td className="px-1.5 py-1.5 md:px-3 md:py-2" style={{ paddingLeft: `${depth * 20 + 8}px` }}>
          <div className="flex items-center gap-1.5 md:gap-2">
            {isWP && hasChildren ? (
              <button
                type="button"
                onClick={() => onToggleExpanded(task.id)}
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent"
                title={isCollapsed ? t('expand') : t('collapse')}
                aria-label={isCollapsed ? t('expand') : t('collapse')}
              >
                <span className={`text-xs transition-transform ${isCollapsed ? '' : 'rotate-90'}`}>▶</span>
              </button>
            ) : (
              <span className="w-5 shrink-0" />
            )}
            <Badge variant={isWP ? 'default' : 'outline'} className="text-[10px] px-1.5 py-0">
              {isWP ? 'WP' : 'ACT'}
            </Badge>
            <span className={`${isWP ? 'font-semibold' : 'font-medium'}`}>{task.name}</span>
            {task.wbsNumber && (
              <span className="text-xs text-muted-foreground">{task.wbsNumber}</span>
            )}
            {isWP && hasChildren && isCollapsed && (
              <span className="text-xs text-muted-foreground">({task.children!.length})</span>
            )}
          </div>
        </td>
        {/*
          WP の担当者は子 ACT から自動集約される (PR #45)。
          旧実装では WP 行で常に '-' をハードコードしていたが、集約済みの値を
          表示できるよう ACT と同じ分岐に統一する。
          子の担当者が混在 / 全員未アサインの場合は DTO 側 assigneeName が undefined
          となり '-' が表示される。
        */}
        <td className="px-1.5 py-1.5 md:px-3 md:py-2 whitespace-nowrap">{task.assigneeName || '-'}</td>
        <td className="px-1.5 py-1.5 md:px-3 md:py-2 whitespace-nowrap">
          <Badge variant={statusColors[task.status] || 'outline'}>
            {TASK_STATUSES[task.status as keyof typeof TASK_STATUSES] || task.status}
          </Badge>
        </td>
        {/* 進捗&工数 */}
        <td className="px-1.5 py-1.5 md:px-3 md:py-2 whitespace-nowrap">
          <div className="flex items-center gap-1.5 md:gap-2">
            <div className="h-2 w-10 md:w-16 rounded-full bg-accent">
              <div className="h-2 rounded-full bg-info" style={{ width: `${task.progressRate}%` }} />
            </div>
            <span>{task.progressRate}%</span>
            {effortText && <span className="text-xs text-muted-foreground">/ {effortText}</span>}
          </div>
        </td>
        {/* 予定期間 */}
        <td className="px-1.5 py-1.5 md:px-3 md:py-2 whitespace-nowrap">{plannedRangeText}</td>
        {/* 実績期間 */}
        <td className="px-1.5 py-1.5 md:px-3 md:py-2 whitespace-nowrap">{actualRangeText}</td>
        {/* PR #168: 添付列 (タスク添付の chips 表示)。他エンティティ一覧と同パターン */}
        <td className="px-1.5 py-1.5 md:px-3 md:py-2" onClick={(e) => e.stopPropagation()}>
          <AttachmentsCell items={attachmentsByEntity[task.id] ?? []} />
        </td>
        {/* 操作 */}
        <td className="px-1.5 py-1.5 md:px-3 md:py-2 whitespace-nowrap">
          <div className="flex gap-1">
            {canOpenEdit && (
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => onEditClick(task)}
                title={t('edit')}
                aria-label={t('edit')}
              >
                <Pencil className="h-4 w-4" />
              </Button>
            )}
            {canEditPmTl && (
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-destructive hover:text-destructive"
                title={t('delete')}
                aria-label={t('delete')}
                onClick={async () => {
                  if (!confirm(isWP ? t('deleteConfirmWp') : t('deleteConfirmActivity'))) return;
                  await onLoading(() =>
                    fetch(`/api/projects/${projectId}/tasks/${task.id}`, { method: 'DELETE' }),
                  );
                  await reload();
                }}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            )}
          </div>
        </td>
      </tr>
      {/* インラインの PM / メンバー編集フォームは廃止。
          編集アイコンクリック時は TasksClient が保持する EditTaskDialog がロール別項目で開く。*/}
      {!isCollapsed && task.children?.map((child) => (
        <TaskTreeNode
          key={child.id}
          task={child}
          depth={depth + 1}
          canEditPmTl={canEditPmTl}
          canSelectForProgress={canSelectForProgress}
          userId={userId}
          projectId={projectId}
          reload={reload}
          onLoading={onLoading}
          isSelected={selectedIds.has(child.id)}
          selectedIds={selectedIds}
          onToggleSelect={onToggleSelect}
          members={members}
          parentOptions={parentOptions}
          onEditClick={onEditClick}
          expandedTaskIds={expandedTaskIds}
          onToggleExpanded={onToggleExpanded}
          showIdColumn={showIdColumn}
          attachmentsByEntity={attachmentsByEntity}
        />
      ))}
    </>
  );
}

/**
 * メモ化: 関連しない再描画を抑制する。
 *
 * 重要: `selectedIds` は比較対象に含める必要がある。子タスクの isSelected は
 * 「この TaskTreeNode の render 結果内で `selectedIds.has(child.id)` を評価して
 * 子 TaskTreeNode に prop として渡す」ため、親 TaskTreeNode が再描画されないと
 * 子 TaskTreeNode に最新の isSelected が届かない。
 *
 * 以前は selectedIds を除外して isSelected (boolean) のみで判定していたが、
 * その結果として **子タスクへの isSelected 変更が伝播せず、子のチェックボックスが
 * UI 上で更新されない不具合** が発生していた。
 */
const TaskTreeNode = memo(TaskTreeNodeImpl, (prev, next) =>
  prev.task === next.task
  && prev.depth === next.depth
  && prev.canEditPmTl === next.canEditPmTl
  && prev.canSelectForProgress === next.canSelectForProgress
  && prev.userId === next.userId
  && prev.projectId === next.projectId
  && prev.reload === next.reload
  && prev.onLoading === next.onLoading
  && prev.isSelected === next.isSelected
  && prev.selectedIds === next.selectedIds
  && prev.onToggleSelect === next.onToggleSelect
  && prev.members === next.members
  && prev.parentOptions === next.parentOptions
  && prev.onEditClick === next.onEditClick
  // PR #61: 展開状態の変化は全ノードの再描画が必要 (子孫が折りたたみ/展開されうるため)
  && prev.expandedTaskIds === next.expandedTaskIds
  && prev.onToggleExpanded === next.onToggleExpanded
  // feat/wbs-overwrite-import: ID 列トグル変化時に全ノード再描画
  && prev.showIdColumn === next.showIdColumn
  // PR #168: 添付バッチ取得結果が変わったら再描画 (object identity 比較で十分、
  // useBatchAttachments が ids 変動時に新オブジェクトを返す)
  && prev.attachmentsByEntity === next.attachmentsByEntity,
);

/**
 * TaskMobileCard — モバイル (md 未満) で WBS 階層を表現するカード形式コンポーネント (PR #128a-2)。
 *
 * 設計方針 (ユーザ合意済):
 *   - (A) 階層+字下げ: depth に応じて左余白を増やし、階層構造を視覚的に保つ
 *   - Expand/collapse は PC と同じ state を共有
 *   - 編集ボタンは PC と同じ onEditClick (既存ダイアログに誘導、新規実装なし)
 *   - 一括選択 (checkbox) は PC のみ (canSelectForProgress と、mobile で非表示)
 *   - 削除は PC と同じ DELETE API を叩く
 *
 * PC UX は一切変更なし (既存 TaskTreeNode / table を md:block で保持)。
 */
function TaskMobileCardImpl({
  task,
  depth,
  canEditPmTl,
  userId,
  projectId,
  reload,
  onLoading,
  members,
  parentOptions,
  onEditClick,
  expandedTaskIds,
  onToggleExpanded,
  attachmentsByEntity,
}: Omit<TaskTreeNodeProps, 'canSelectForProgress' | 'isSelected' | 'selectedIds' | 'onToggleSelect' | 'showIdColumn'>) {
  const t = useTranslations('wbs');
  const unsetLabel = t('unsetShort');
  const isWP = task.type === 'work_package';
  const hasChildren = task.children && task.children.length > 0;
  const isCollapsed = isWP && hasChildren ? !expandedTaskIds.has(task.id) : false;
  const isAssignee = task.assigneeId === userId;
  const canMemberEdit = !isWP && isAssignee;
  const canOpenEdit = canEditPmTl || canMemberEdit;
  const plannedRangeText = (() => {
    if (!task.plannedStartDate && !task.plannedEndDate) return '-';
    return `${task.plannedStartDate || unsetLabel} 〜 ${task.plannedEndDate || unsetLabel}`;
  })();
  const actualRangeText = (() => {
    if (!task.actualStartDate && !task.actualEndDate) return '-';
    return `${task.actualStartDate || unsetLabel} 〜 ${task.actualEndDate || unsetLabel}`;
  })();
  const effortText = task.plannedEffort > 0 ? `${task.plannedEffort}h` : null;
  void parentOptions;
  void members;

  // 階層字下げ: depth * 12px、max 48px (4 階層以降は同じ余白で見切れを防止)
  const indent = Math.min(depth, 4) * 12;

  return (
    <>
      <div
        className={`rounded-md border p-3 text-sm ${isWP ? 'bg-muted/50' : 'bg-card'}`}
        style={{ marginLeft: `${indent}px` }}
      >
        <div className="flex items-start gap-2">
          {isWP && hasChildren ? (
            <button
              type="button"
              onClick={() => onToggleExpanded(task.id)}
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent"
              title={isCollapsed ? t('expand') : t('collapse')}
              aria-label={isCollapsed ? t('expand') : t('collapse')}
            >
              <span className={`text-xs transition-transform ${isCollapsed ? '' : 'rotate-90'}`}>▶</span>
            </button>
          ) : (
            <span className="w-6 shrink-0" />
          )}
          <div className="flex-1 min-w-0">
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge variant={isWP ? 'default' : 'outline'} className="text-[10px] px-1.5 py-0">
                {isWP ? 'WP' : 'ACT'}
              </Badge>
              <span className={`${isWP ? 'font-semibold' : 'font-medium'}`}>{task.name}</span>
              {task.wbsNumber && (
                <span className="text-xs text-muted-foreground">{task.wbsNumber}</span>
              )}
              {isWP && hasChildren && isCollapsed && (
                <span className="text-xs text-muted-foreground">({task.children!.length})</span>
              )}
            </div>
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
              <dt className="text-xs text-muted-foreground">{t('columnAssignee')}</dt>
              <dd>{task.assigneeName || '-'}</dd>
              <dt className="text-xs text-muted-foreground">{t('columnStatus')}</dt>
              <dd>
                <Badge variant={statusColors[task.status] || 'outline'} className="text-[10px]">
                  {TASK_STATUSES[task.status as keyof typeof TASK_STATUSES] || task.status}
                </Badge>
              </dd>
              <dt className="text-xs text-muted-foreground">{t('columnProgress')}</dt>
              <dd className="flex items-center gap-1.5">
                <div className="h-2 w-16 rounded-full bg-accent">
                  <div className="h-2 rounded-full bg-info" style={{ width: `${task.progressRate}%` }} />
                </div>
                <span>{task.progressRate}%</span>
                {effortText && <span className="text-xs text-muted-foreground">/ {effortText}</span>}
              </dd>
              <dt className="text-xs text-muted-foreground">{t('columnPlanned')}</dt>
              <dd className="text-xs">{plannedRangeText}</dd>
              <dt className="text-xs text-muted-foreground">{t('columnActual')}</dt>
              <dd className="text-xs">{actualRangeText}</dd>
              {/* PR #168: 添付 chips (mobile card は 1 行で chip 列) */}
              <dt className="text-xs text-muted-foreground">{t('columnAttachments')}</dt>
              <dd className="text-xs"><AttachmentsCell items={attachmentsByEntity[task.id] ?? []} /></dd>
            </dl>
          </div>
          <div className="flex flex-col gap-1">
            {canOpenEdit && (
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => onEditClick(task)}
                title={t('edit')}
                aria-label={t('edit')}
              >
                <Pencil className="h-4 w-4" />
              </Button>
            )}
            {canEditPmTl && (
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-destructive hover:text-destructive"
                title={t('delete')}
                aria-label={t('delete')}
                onClick={async () => {
                  if (!confirm(isWP ? t('deleteConfirmWp') : t('deleteConfirmActivity'))) return;
                  await onLoading(() =>
                    fetch(`/api/projects/${projectId}/tasks/${task.id}`, { method: 'DELETE' }),
                  );
                  await reload();
                }}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            )}
          </div>
        </div>
      </div>
      {!isCollapsed && task.children?.map((child) => (
        <TaskMobileCard
          key={child.id}
          task={child}
          depth={depth + 1}
          canEditPmTl={canEditPmTl}
          userId={userId}
          projectId={projectId}
          reload={reload}
          onLoading={onLoading}
          members={members}
          parentOptions={parentOptions}
          onEditClick={onEditClick}
          expandedTaskIds={expandedTaskIds}
          onToggleExpanded={onToggleExpanded}
          attachmentsByEntity={attachmentsByEntity}
        />
      ))}
    </>
  );
}

const TaskMobileCard = memo(TaskMobileCardImpl, (prev, next) =>
  prev.task === next.task
  && prev.depth === next.depth
  && prev.canEditPmTl === next.canEditPmTl
  && prev.userId === next.userId
  && prev.projectId === next.projectId
  && prev.reload === next.reload
  && prev.onLoading === next.onLoading
  && prev.members === next.members
  && prev.parentOptions === next.parentOptions
  && prev.onEditClick === next.onEditClick
  && prev.expandedTaskIds === next.expandedTaskIds
  && prev.onToggleExpanded === next.onToggleExpanded
  // PR #168: 添付バッチ取得結果が変わったら再描画
  && prev.attachmentsByEntity === next.attachmentsByEntity,
);

export function TasksClient({ projectId, tasks, members, projectRole, systemRole, userId, onReload }: Props) {
  const tAction = useTranslations('action');
  const tAttachment = useTranslations('attachment');
  const t = useTranslations('wbs');
  const router = useRouter();
  const { withLoading } = useLoading();
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [error, setError] = useState('');
  // feat/gantt-tab-restructure (PR-C item 6): WBS タブ内で Gantt を切り替え表示する state
  const [showGantt, setShowGantt] = useState(false);
  // fix/wbs-filter-regression: モバイル時のフィルタ折りたたみ state (md+ では常時開)
  const [isFilterMobileOpen, setIsFilterMobileOpen] = useState(false);

  // 親から渡された遅延フェッチ再取得ハンドラ。未指定時は router.refresh() にフォールバック。
  const reload = useCallback(async () => {
    if (onReload) {
      await onReload();
    } else {
      router.refresh();
    }
  }, [onReload, router]);

  const canEditPmTl = systemRole === 'admin' || projectRole === 'pm_tl';
  // PR #87: member ロールでも「自分担当タスク」の実績系一括更新 (status / progressRate /
  // actualStartDate / actualEndDate) は可能。UI 側のチェックボックス列と一括パネル自体は
  // 表示し、操作できるボタンだけ絞り込む (pm_tl: 全機能 / member: 実績更新のみ)。
  // 旧実装は canEditPmTl ゲートで member には何も表示していなかったため、
  // PR #85 で緩和した API 側の権限判定が UI からは使えない状態になっていた。
  const canSelectForProgress = canEditPmTl || projectRole === 'member';
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // --- 担当者フィルタ (PR #61: sessionStorage 永続化) ---
  // デフォルト: 全メンバー + 未アサインを選択済み（= 全タスク表示）。
  // 新規メンバー追加時は自動では追加されないが「すべて選択」で救済可能。
  const allAssigneeKeys = useMemo<string[]>(
    () => [...members.map((m) => m.userId), UNASSIGNED_KEY],
    [members],
  );
  const [assigneeFilter, setAssigneeFilter] = useSessionStringSet(
    `wbs:${projectId}:assignee-filter`,
    () => allAssigneeKeys,
  );
  const isAllAssigneesSelected
    = assigneeFilter.size === allAssigneeKeys.length
    && allAssigneeKeys.every((k) => assigneeFilter.has(k));
  const toggleAssignee = useCallback((key: string) => {
    setAssigneeFilter((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, [setAssigneeFilter]);
  const selectAllAssignees = useCallback(() => {
    setAssigneeFilter(() => new Set(allAssigneeKeys));
  }, [allAssigneeKeys, setAssigneeFilter]);
  const clearAllAssignees = useCallback(() => {
    setAssigneeFilter(() => new Set());
  }, [setAssigneeFilter]);

  // --- 状況 (status) フィルタ (PR #61) ---
  const [statusFilter, setStatusFilter] = useSessionStringSet(
    `wbs:${projectId}:status-filter`,
    () => [...ALL_STATUS_KEYS],
  );
  const isAllStatusesSelected
    = statusFilter.size === ALL_STATUS_KEYS.length
    && ALL_STATUS_KEYS.every((k) => statusFilter.has(k));
  const toggleStatus = useCallback((key: string) => {
    setStatusFilter((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, [setStatusFilter]);
  const selectAllStatuses = useCallback(() => {
    setStatusFilter(() => new Set(ALL_STATUS_KEYS));
  }, [setStatusFilter]);
  const clearAllStatuses = useCallback(() => {
    setStatusFilter(() => new Set());
  }, [setStatusFilter]);

  // --- WP 展開状態 (PR #61: sessionStorage 永続化) ---
  const [expandedTaskIds, setExpandedTaskIds] = useSessionStringSet(
    `wbs:${projectId}:expanded-tasks`,
    () => [],
  );
  const toggleExpanded = useCallback((taskId: string) => {
    setExpandedTaskIds((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  }, [setExpandedTaskIds]);

  // 表示用のフィルタ済みタスクツリー (担当者 + 状況の AND)
  const filteredTasks = useMemo(() => {
    let t = tasks;
    if (!isAllAssigneesSelected) t = filterTreeByAssignee(t, assigneeFilter);
    if (!isAllStatusesSelected) t = filterTreeByStatus(t, statusFilter);
    return t;
  }, [tasks, assigneeFilter, isAllAssigneesSelected, statusFilter, isAllStatusesSelected]);

  // --- 編集ダイアログ（個別タスクをアイコンから開いて編集）---
  // 1 ダイアログを複数タスクで共有（TasksClient レベルで保持し、編集対象が null の間は非表示）
  type EditForm = {
    type: 'work_package' | 'activity';
    parentTaskId: string;
    name: string;
    assigneeId: string;
    plannedStartDate: string;
    plannedEndDate: string;
    plannedEffort: number;
    status: string;
    progressRate: number;
    actualStartDate: string;
    actualEndDate: string;
  };
  const initEditForm = (task: TaskDTO): EditForm => ({
    type: task.type as 'work_package' | 'activity',
    parentTaskId: task.parentTaskId ?? '',
    name: task.name,
    assigneeId: task.assigneeId ?? '',
    plannedStartDate: task.plannedStartDate ?? '',
    plannedEndDate: task.plannedEndDate ?? '',
    plannedEffort: task.plannedEffort,
    status: task.status,
    progressRate: task.progressRate,
    actualStartDate: task.actualStartDate ?? '',
    actualEndDate: task.actualEndDate ?? '',
  });
  const [editingTask, setEditingTask] = useState<TaskDTO | null>(null);
  const [editForm, setEditForm] = useState<EditForm | null>(null);
  const [editError, setEditError] = useState('');
  const openEditDialog = useCallback((task: TaskDTO) => {
    setEditingTask(task);
    setEditForm(initEditForm(task));
    setEditError('');
    // initEditForm は pure 関数相当でクロージャも安定しているため deps 不要
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const closeEditDialog = useCallback(() => {
    setEditingTask(null);
    setEditForm(null);
    setEditError('');
  }, []);
  // 編集対象のロール判定
  const isEditingActivity = editingTask?.type === 'activity';
  const editingIsAssignee = editingTask?.assigneeId === userId;
  const editingCanUpdatePm = canEditPmTl; // PM/TL は「編集」系すべて可
  // PR #88: 実績項目は担当者本人のみ更新可能 (admin/pm_tl 含む)。
  // 「実績」は担当者が自身の work について記録するものという業務上の原則に揃える。
  // 従来は pm_tl も他人担当の実績を編集できたが、ユーザ要望により担当者のみに制限。
  // 担当者以外の管理者が実績を補正したい場合は、担当者を変更してから該当担当者が
  // 更新するか、監査ログで値を確認するフローになる。
  const editingCanUpdateActual = isEditingActivity && editingIsAssignee;
  // 実績日付 disable 判定（PR #39 の整合性ルールに準拠）
  const editingActualStartDisabled = editForm?.status === 'not_started';
  const editingActualEndDisabled = editForm?.status !== 'completed';

  async function handleEditDialogSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!editingTask || !editForm) return;
    setEditError('');
    const body: Record<string, unknown> = {};

    // PM/TL 編集項目（PM/TL のみ送信）
    if (editingCanUpdatePm) {
      body.type = editForm.type;
      body.name = editForm.name;
      body.parentTaskId = editForm.parentTaskId || null;
      if (editForm.type === 'activity') {
        body.assigneeId = editForm.assigneeId || null;
        body.plannedStartDate = editForm.plannedStartDate || null;
        body.plannedEndDate = editForm.plannedEndDate || null;
        body.plannedEffort = editForm.plannedEffort;
      }
    }
    // 実績系（PM/TL または担当者本人）
    if (editingCanUpdateActual) {
      body.status = editForm.status;
      body.progressRate = editForm.progressRate;
      body.actualStartDate = editForm.actualStartDate || null;
      body.actualEndDate = editForm.actualEndDate || null;
    }

    const res = await withLoading(() =>
      fetch(`/api/projects/${projectId}/tasks/${editingTask.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
    if (!res.ok) {
      let message = t('updateFailed');
      try {
        const json = await res.json();
        message = json.error?.message || json.error?.details?.[0]?.message || message;
      } catch {}
      setEditError(message);
      return;
    }
    closeEditDialog();
    await reload();
  }

  // 全タスクIDの一覧（全選択用）。担当者フィルタで隠れているタスクは対象外。
  const allTaskIds = useMemo(() => collectAllIds(filteredTasks), [filteredTasks]);

  const isAllSelected = allTaskIds.length > 0 && allTaskIds.every((id) => selectedIds.has(id));

  // PR #168: WBS 一覧の添付列。filteredTasks ツリー全タスクの添付を 1 クエリでバッチ取得。
  // 他エンティティ一覧 (risks-client / project-knowledge-client / memos-client 等) と同パターン。
  const attachmentsByEntity = useBatchAttachments('task', allTaskIds);

  function toggleSelectAll() {
    if (isAllSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(allTaskIds));
    }
  }

  /**
   * タスクのチェック状態をトグルする。
   * 対象ノードが子をもつ WP の場合は **自身 + 全子孫（子 WP・子 ACT・孫以降）を一括で**
   * チェック / アンチェックする。これによりユーザが親 WP を選択した瞬間に、
   * その配下すべてが選択状態になる。
   *
   * tasks が変わると callback identity も変わるが、その時点で各 TaskTreeNode の
   * task prop 自体も変わっている（memo が再描画を許容）ため追加コストはない。
   */
  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      const affectedIds = collectSelfAndDescendantIds(tasks, id);
      if (affectedIds.length === 0) {
        // ツリーで見つからない（通常ありえない）→ フォールバックで単体トグル
        if (next.has(id)) next.delete(id); else next.add(id);
        return next;
      }
      const wasChecked = next.has(id);
      if (wasChecked) {
        // 自身 + 子孫を一括アンチェック
        for (const affected of affectedIds) next.delete(affected);
      } else {
        // 自身 + 子孫を一括チェック
        for (const affected of affectedIds) next.add(affected);
      }
      return next;
    });
  }, [tasks]);

  // --- 一括編集（PM/TL 編集フォーム相当）ダイアログ ---
  // ダイアログを新しく開き直したときは初期値（apply=全 false / values=既定）に戻すポリシー。
  // 以前のセッションの入力値が残っていると「他タスクでの選択が引き継がれてしまう」UX バグになるため。
  // PR #63: 優先度は UI から撤去 (将来 impact × likelihood から自動算出予定)
  type BulkEditApply = {
    assigneeId: boolean;
    plannedStartDate: boolean;
    plannedEndDate: boolean;
    plannedEffort: boolean;
  };
  type BulkEditValues = {
    assigneeId: string;
    plannedStartDate: string;
    plannedEndDate: string;
    plannedEffort: number;
  };
  const bulkEditInitialApply = (): BulkEditApply => ({
    assigneeId: false,
    plannedStartDate: false,
    plannedEndDate: false,
    plannedEffort: false,
  });
  const bulkEditInitialValues = (): BulkEditValues => ({
    assigneeId: '',
    plannedStartDate: '',
    plannedEndDate: '',
    plannedEffort: 0,
  });
  const [isBulkEditOpen, setIsBulkEditOpen] = useState(false);
  const [bulkEditApply, setBulkEditApply] = useState<BulkEditApply>(bulkEditInitialApply);
  const [bulkEditValues, setBulkEditValues] = useState<BulkEditValues>(bulkEditInitialValues);
  const [bulkEditError, setBulkEditError] = useState('');

  // --- 一括実績更新（メンバー 実績フォーム相当）ダイアログ ---
  type BulkActualApply = {
    status: boolean;
    progressRate: boolean;
    actualStartDate: boolean;
    actualEndDate: boolean;
  };
  type BulkActualValues = {
    status: string;
    progressRate: number;
    actualStartDate: string;
    actualEndDate: string;
  };
  const bulkActualInitialApply = (): BulkActualApply => ({
    status: false,
    progressRate: false,
    actualStartDate: false,
    actualEndDate: false,
  });
  const bulkActualInitialValues = (): BulkActualValues => ({
    status: 'not_started',
    progressRate: 0,
    actualStartDate: '',
    actualEndDate: '',
  });
  const [isBulkActualOpen, setIsBulkActualOpen] = useState(false);
  const [bulkActualApply, setBulkActualApply] = useState<BulkActualApply>(bulkActualInitialApply);
  const [bulkActualValues, setBulkActualValues] = useState<BulkActualValues>(bulkActualInitialValues);
  const [bulkActualError, setBulkActualError] = useState('');

  // ダイアログを開くタイミングで state を初期化する共通ハンドラ。
  // onOpenChange に直接束縛することで「開くたびに初期値に戻る」挙動を保証する。
  const handleBulkEditOpenChange = useCallback(
    (open: boolean) => {
      setIsBulkEditOpen(open);
      if (open) {
        setBulkEditApply(bulkEditInitialApply());
        setBulkEditValues(bulkEditInitialValues());
        setBulkEditError('');
      }
    },
    // 初期値ファクトリは毎回新規生成されるが内容は固定なので deps から除外
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const handleBulkActualOpenChange = useCallback(
    (open: boolean) => {
      setIsBulkActualOpen(open);
      if (open) {
        setBulkActualApply(bulkActualInitialApply());
        setBulkActualValues(bulkActualInitialValues());
        setBulkActualError('');
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  async function handleBulkDelete() {
    if (selectedIds.size === 0) return;
    if (!confirm(t('bulkDeleteConfirm', { count: selectedIds.size }))) return;
    for (const id of selectedIds) {
      await withLoading(() =>
        fetch(`/api/projects/${projectId}/tasks/${id}`, { method: 'DELETE' }),
      );
    }
    setSelectedIds(new Set());
    await reload();
  }

  /** 一括更新 API を叩く共通関数。`updates` には apply=true のフィールドのみ入っている想定 */
  async function postBulkUpdate(updates: Record<string, unknown>): Promise<string | null> {
    if (selectedIds.size === 0) return t('noTargetTasks');
    if (Object.keys(updates).length === 0) return t('selectAtLeastOneField');

    const res = await withLoading(() =>
      fetch(`/api/projects/${projectId}/tasks/bulk-update`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskIds: [...selectedIds], ...updates }),
      }),
    );
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      return json.error?.message || json.error?.details?.[0]?.message || t('bulkUpdateFailed');
    }
    return null;
  }

  async function handleBulkEditSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBulkEditError('');
    const updates: Record<string, unknown> = {};
    if (bulkEditApply.assigneeId) updates.assigneeId = bulkEditValues.assigneeId || null;
    if (bulkEditApply.plannedStartDate) updates.plannedStartDate = bulkEditValues.plannedStartDate || null;
    if (bulkEditApply.plannedEndDate) updates.plannedEndDate = bulkEditValues.plannedEndDate || null;
    if (bulkEditApply.plannedEffort) updates.plannedEffort = bulkEditValues.plannedEffort;

    const err = await postBulkUpdate(updates);
    if (err) {
      setBulkEditError(err);
      return;
    }
    setIsBulkEditOpen(false);
    setSelectedIds(new Set());
    // ※ apply / values の明示リセットは不要。次回開く際に onOpenChange→
    //    handleBulkEditOpenChange(true) が必ずリセットを行うため。
    await reload();
  }

  async function handleBulkActualSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBulkActualError('');
    const updates: Record<string, unknown> = {};
    if (bulkActualApply.status) updates.status = bulkActualValues.status;
    if (bulkActualApply.progressRate) updates.progressRate = bulkActualValues.progressRate;
    if (bulkActualApply.actualStartDate) updates.actualStartDate = bulkActualValues.actualStartDate || null;
    if (bulkActualApply.actualEndDate) updates.actualEndDate = bulkActualValues.actualEndDate || null;

    const err = await postBulkUpdate(updates);
    if (err) {
      setBulkActualError(err);
      return;
    }
    setIsBulkActualOpen(false);
    setSelectedIds(new Set());
    // ※ 同上。リセットは onOpenChange 経由
    await reload();
  }

  // PR #68: 集計再計算 handler は UI 撤去に伴い削除済み。
  // API ルート `/api/projects/[id]/tasks/recalculate` 自体は残す
  // (管理者がトラブルシュート時に直接叩く手段として温存)。

  // T-19: WBS エクスポート (7 列 = ID/種別/名称/レベル/予定開始日/予定終了日/予定工数)。
  // Phase B 要件 20 (2026-04-28): 日本語文字化けバグ修正。
  //   サーバ側で BOM 付き UTF-8 を返すが、`res.text()` は WHATWG Fetch 仕様により
  //   先頭の BOM を **strip して返す** ため、client 側で `'﻿' + csvText` として
  //   BOM を再付与する必要がある。これがないと Excel が Shift_JIS と誤解釈し
  //   日本語が文字化けする。
  async function handleWbsExport() {
    const body: Record<string, unknown> = {};
    if (selectedIds.size > 0) body.taskIds = [...selectedIds];

    const res = await withLoading(() =>
      fetch(`/api/projects/${projectId}/tasks/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
    if (!res.ok) return;
    const csvText = await res.text();
    // BOM を再付与 (res.text() で strip されるため)
    const blob = new Blob(['﻿' + csvText], { type: 'text/csv; charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `wbs-${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // feat/wbs-overwrite-import: ID 表示トグル + 上書きインポートダイアログ state
  const [showIdColumn, setShowIdColumn] = useState(false);
  const [isSyncImportOpen, setIsSyncImportOpen] = useState(false);

  const [createType, setCreateType] = useState<'work_package' | 'activity'>('activity');
  const [parentTaskId, setParentTaskId] = useState('');

  // 親候補: WP のフラット一覧（ツリーを再帰的に展開）
  const parentOptions = useMemo(() => {
    function flattenWPs(nodes: TaskDTO[], depth = 0): { id: string; label: string }[] {
      const result: { id: string; label: string }[] = [];
      for (const node of nodes) {
        if (node.type === 'work_package') {
          result.push({ id: node.id, label: `${'　'.repeat(depth)}${node.name}` });
          if (node.children) {
            result.push(...flattenWPs(node.children, depth + 1));
          }
        }
      }
      return result;
    }
    return flattenWPs(tasks);
  }, [tasks]);

  const [form, setForm] = useState({
    name: '',
    // fix/quick-ux item 8: デフォルト担当者=自分。プルダウンで変更可。
    assigneeId: userId,
    plannedStartDate: '',
    plannedEndDate: '',
    plannedEffort: 0,
  });

  // PR #67: 作成時にステージする添付 URL
  const [stagedCreateAttachments, setStagedCreateAttachments] = useState<StagedAttachment[]>([]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError('');

    // PR #63: UI から「優先度」を撤去。サーバ側バリデータは optional 扱いのため省略で OK。
    const base = createType === 'work_package'
      ? { type: 'work_package', name: form.name }
      : {
          type: 'activity',
          name: form.name,
          assigneeId: form.assigneeId,
          plannedStartDate: form.plannedStartDate,
          plannedEndDate: form.plannedEndDate,
          plannedEffort: form.plannedEffort,
        };

    const body = parentTaskId ? { ...base, parentTaskId } : base;

    const res = await withLoading(() =>
      fetch(`/api/projects/${projectId}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );

    if (!res.ok) {
      const json = await res.json();
      setError(json.error?.message || json.error?.details?.[0]?.message || t('createFailed'));
      return;
    }

    // PR #67: 作成成功直後にステージされた添付を一括 POST
    const json = await res.json();
    if (stagedCreateAttachments.length > 0 && json.data?.id) {
      await persistStagedAttachments({
        entityType: 'task',
        entityId: json.data.id,
        items: stagedCreateAttachments,
      });
    }
    setStagedCreateAttachments([]);

    setIsCreateOpen(false);
    setParentTaskId('');
    // fix/quick-ux item 8: 連続起票でも担当者は自分にリセット
    setForm({ name: '', assigneeId: userId, plannedStartDate: '', plannedEndDate: '', plannedEffort: 0 });
    await reload();
  }

  return (
    <div className="space-y-6">
      {/* Phase A 要件 6: h2 ページタイトル削除 (タブ名と重複のため) */}
      <div className="flex items-center justify-end">
        <div className="flex gap-2">
        {/* feat/gantt-tab-restructure (PR-C item 6): ガント表示トグル (全ユーザに開放、WBS タブ統合) */}
        <Button variant="outline" size="sm" onClick={() => setShowGantt((v) => !v)}>
          {showGantt ? t('hideGantt') : t('showGantt')}
        </Button>
        {/* feat/wbs-overwrite-import: 一覧画面に ID 列を表示するトグル (CSV 整合確認用、既定 OFF) */}
        <Button
          variant={showIdColumn ? 'default' : 'outline'}
          size="sm"
          onClick={() => setShowIdColumn((v) => !v)}
          title={t('idToggleTooltip')}
        >
          {showIdColumn ? t('hideId') : t('showId')}
        </Button>
        {canEditPmTl && (
          <>
          {/*
            T-19 (PR-ζ follow-up): WBS のエクスポート/インポート ボタンを 2 ボタン構成で完成。
            - エクスポート: 7 列 (ID/種別/名称/レベル/予定開始日/予定終了日/予定工数) を CSV 出力
            - インポート: sync-import dialog で ID 有無により新規/更新を自動分岐 (dry-run + preview)
            担当者 / 優先度 / マイルストーン / 備考 / WBS 番号 / 進捗系列は CSV では扱わず UI 個別編集に集約。
          */}
          <Button variant="outline" size="sm" onClick={handleWbsExport}>
            {selectedIds.size > 0 ? t('exportWithCount', { count: selectedIds.size }) : t('export')}
          </Button>
          <Button variant="outline" size="sm" onClick={() => setIsSyncImportOpen(true)}>
            {t('import')}
          </Button>
          <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
            <DialogTrigger render={<Button size="sm" />}>{tAction('add')}</DialogTrigger>
            {/* PR #87 横展開: アクティビティ作成ダイアログも grid-cols-2 + DateFieldWithActions を
                含むため、編集ダイアログ同様 max-w-[min(90vw,42rem)] に揃えて日付項目の縦書き崩れを防ぐ。 */}
            <DialogContent className="max-w-[min(90vw,42rem)]">
              <DialogHeader>
                <DialogTitle>{createType === 'work_package' ? t('createWorkPackageTitle') : t('createActivityTitle')}</DialogTitle>
                <DialogDescription>
                  {createType === 'work_package'
                    ? t('createWorkPackageDescription')
                    : t('createActivityDescription')}
                </DialogDescription>
              </DialogHeader>
              <form onSubmit={handleCreate} className="space-y-4">
                {error && (
                  <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>
                )}
                <div className="space-y-2">
                  <Label>{t('type')}</Label>
                  <select
                    value={createType}
                    onChange={(e) => setCreateType(e.target.value as 'work_package' | 'activity')}
                    className={nativeSelectClass}
                  >
                    {Object.entries(WBS_TYPES).map(([key, label]) => (
                      <option key={key} value={key}>{label}</option>
                    ))}
                  </select>
                </div>
                <div className="space-y-2">
                  <Label>{t('parentWorkPackage')}</Label>
                  <select
                    value={parentTaskId}
                    onChange={(e) => setParentTaskId(e.target.value)}
                    className={nativeSelectClass}
                  >
                    <option value="">{t('noParentTopLevel')}</option>
                    {parentOptions.map((p) => (
                      <option key={p.id} value={p.id}>{p.label}</option>
                    ))}
                  </select>
                </div>
                <div className="space-y-2">
                  <Label>{t('columnName')}</Label>
                  <Input
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    maxLength={100}
                    required
                  />
                </div>

                {createType === 'activity' && (
                  <>
                    <div className="space-y-2">
                      <Label>{t('columnAssignee')}</Label>
                      {members.length === 0 ? (
                        <p className="text-sm text-destructive">{t('noMembersWarning')}</p>
                      ) : (
                        <select
                          value={form.assigneeId}
                          onChange={(e) => setForm({ ...form, assigneeId: e.target.value })}
                          className={nativeSelectClass}
                          required
                        >
                          <option value="">{t('selectPlaceholder')}</option>
                          {members.map((m) => (
                            <option key={m.userId} value={m.userId}>{m.userName}</option>
                          ))}
                        </select>
                      )}
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label>{t('plannedStartDate')}</Label>
                        <DateFieldWithActions value={form.plannedStartDate} onChange={(v) => setForm({ ...form, plannedStartDate: v })} required hideClear />
                      </div>
                      <div className="space-y-2">
                        <Label>{t('plannedEndDate')}</Label>
                        <DateFieldWithActions value={form.plannedEndDate} onChange={(v) => setForm({ ...form, plannedEndDate: v })} required hideClear />
                      </div>
                    </div>
                    <div className="space-y-2">
                      <Label>{t('plannedEffort')}</Label>
                      <NumberInput min={1} step={0.5} value={form.plannedEffort} onChange={(n) => setForm({ ...form, plannedEffort: n })} required />
                    </div>
                  </>
                )}

                {/* PR #67: 作成と同時に成果物・設計書等の関連 URL を登録可能 */}
                <StagedAttachmentsInput
                  value={stagedCreateAttachments}
                  onChange={setStagedCreateAttachments}
                />

                <Button type="submit" className="w-full">
                  {tAction('create')}
                </Button>
              </form>
            </DialogContent>
          </Dialog>
          </>
        )}
        </div>
      </div>

      {/* feat/gantt-tab-restructure (PR-C item 6): ガント表示エリア (toggle で開閉)。
          tasks (tree) と members は本コンポーネントが既に保持しているため再 fetch 不要。 */}
      {showGantt && (
        <div className="rounded-lg border p-2">
          <GanttClient projectId={projectId} tasks={tasks} members={members} />
        </div>
      )}

      {/*
        フィルタ (担当者 + 状況、PR #61)
        モバイル (md 未満) では React state で折りたたみ可能、PC (md+) では常時展開。
        旧実装 (PR #128a-2) で `<details className="md:open:">` という壊れた Tailwind
        ユーティリティ (md:open: は存在しない) で「PC 常時展開」を試みていたため、
        実際には PC でもフィルタが折りたたまれて表示されない degression が発生していた。
        fix/wbs-filter-regression: state-driven 折りたたみ + `md:!block` で PC 常時展開を確定。
      */}
      <div data-testid="wbs-filter-container">
        <button
          type="button"
          className="flex w-full cursor-pointer items-center gap-2 rounded-md border border-input bg-card px-3 py-2 text-sm md:hidden"
          onClick={() => setIsFilterMobileOpen((v) => !v)}
          aria-expanded={isFilterMobileOpen}
        >
          <span className="flex-1 text-left font-medium">{t('filterSort')}</span>
          <span className="text-xs text-muted-foreground">
            {isFilterMobileOpen ? t('tapToCollapse') : t('tapToExpand')}
          </span>
        </button>
        {/* mobile では state、md+ では常時 flex 表示 (md:!flex で強制上書き) */}
        <div
          className={`mt-2 flex-wrap items-center gap-2 md:mt-0 md:!flex ${
            isFilterMobileOpen ? 'flex' : 'hidden'
          }`}
          data-testid="wbs-filter-controls"
        >
          <MultiSelectFilter
            label={t('columnAssignee')}
            options={[
              ...members.map((m) => ({ value: m.userId, label: m.userName })),
              { value: UNASSIGNED_KEY, label: t('unassigned'), muted: true },
            ]}
            selected={assigneeFilter}
            onToggle={toggleAssignee}
            onSelectAll={selectAllAssignees}
            onClearAll={clearAllAssignees}
            isAllSelected={isAllAssigneesSelected}
            allLabel={t('allAssignees')}
          />
          <MultiSelectFilter
            label={t('status')}
            options={ALL_STATUS_KEYS.map((k) => ({ value: k, label: TASK_STATUSES[k] }))}
            selected={statusFilter}
            onToggle={toggleStatus}
            onSelectAll={selectAllStatuses}
            onClearAll={clearAllStatuses}
            isAllSelected={isAllStatusesSelected}
          />
          {(!isAllAssigneesSelected || !isAllStatusesSelected) && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => { selectAllAssignees(); selectAllStatuses(); }}
            >
              {t('filterClear')}
            </Button>
          )}
        </div>
      </div>

      {/* PR #128a-2: 一括操作バーはモバイル未提供 (md:flex で PC のみ表示)。
          モバイルではそもそもチェックボックス列を非表示にしているため、ここに来ても操作できない。 */}
      {canSelectForProgress && selectedIds.size > 0 && (
        <div className="hidden flex-wrap items-center gap-3 rounded-lg border border-info/30 bg-info/10 px-4 py-2 md:flex">
          <span className="text-sm font-medium">{t('selectedCount', { count: selectedIds.size })}</span>
          {/* PR #87: 一括編集 (計画系) と 一括削除 は pm_tl+ のみ。member には一括実績更新のみ露出。 */}
          {canEditPmTl && (
          <Dialog open={isBulkEditOpen} onOpenChange={handleBulkEditOpenChange}>
            <DialogTrigger render={<Button variant="outline" size="sm" />}>{t('bulkEdit')}</DialogTrigger>
            <DialogContent className="max-w-[min(90vw,36rem)] max-h-[80vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>{t('bulkEditTitle', { count: selectedIds.size })}</DialogTitle>
                <DialogDescription>
                  {t('bulkEditDescription')}
                </DialogDescription>
              </DialogHeader>
              <form onSubmit={handleBulkEditSubmit} className="space-y-4">
                {bulkEditError && (
                  <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{bulkEditError}</div>
                )}
                <ApplyFieldRow
                  apply={bulkEditApply.assigneeId}
                  onApplyChange={(v) => setBulkEditApply({ ...bulkEditApply, assigneeId: v })}
                  label={t('columnAssignee')}
                >
                  <select
                    value={bulkEditValues.assigneeId}
                    onChange={(e) => setBulkEditValues({ ...bulkEditValues, assigneeId: e.target.value })}
                    className={nativeSelectClass}
                  >
                    <option value="">{t('notSet')}</option>
                    {members.map((m) => (
                      <option key={m.userId} value={m.userId}>{m.userName}</option>
                    ))}
                  </select>
                </ApplyFieldRow>
                <ApplyFieldRow
                  apply={bulkEditApply.plannedStartDate}
                  onApplyChange={(v) => setBulkEditApply({ ...bulkEditApply, plannedStartDate: v })}
                  label={t('plannedStartDateBulk')}
                >
                  <DateFieldWithActions
                    value={bulkEditValues.plannedStartDate}
                    onChange={(v) => setBulkEditValues({ ...bulkEditValues, plannedStartDate: v })}
                  />
                </ApplyFieldRow>
                <ApplyFieldRow
                  apply={bulkEditApply.plannedEndDate}
                  onApplyChange={(v) => setBulkEditApply({ ...bulkEditApply, plannedEndDate: v })}
                  label={t('plannedEndDateBulk')}
                >
                  <DateFieldWithActions
                    value={bulkEditValues.plannedEndDate}
                    onChange={(v) => setBulkEditValues({ ...bulkEditValues, plannedEndDate: v })}
                  />
                </ApplyFieldRow>
                <ApplyFieldRow
                  apply={bulkEditApply.plannedEffort}
                  onApplyChange={(v) => setBulkEditApply({ ...bulkEditApply, plannedEffort: v })}
                  label={t('plannedEffort')}
                >
                  <NumberInput
                    min={1}
                    step={0.5}
                    value={bulkEditValues.plannedEffort}
                    onChange={(n) => setBulkEditValues({ ...bulkEditValues, plannedEffort: n })}
                  />
                </ApplyFieldRow>
                <Button type="submit" className="w-full">{t('bulkApply')}</Button>
              </form>
            </DialogContent>
          </Dialog>
          )}
          <Dialog open={isBulkActualOpen} onOpenChange={handleBulkActualOpenChange}>
            <DialogTrigger render={<Button variant="outline" size="sm" />}>{t('bulkActualUpdate')}</DialogTrigger>
            <DialogContent className="max-w-[min(90vw,36rem)] max-h-[80vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>{t('bulkActualTitle', { count: selectedIds.size })}</DialogTitle>
                <DialogDescription>
                  {t('bulkActualDescription')}
                </DialogDescription>
              </DialogHeader>
              <form onSubmit={handleBulkActualSubmit} className="space-y-4">
                {bulkActualError && (
                  <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{bulkActualError}</div>
                )}
                <div className="rounded-md bg-muted p-3 text-xs text-muted-foreground">
                  {t('statusConsistencyHint')}
                </div>
                <ApplyFieldRow
                  apply={bulkActualApply.status}
                  onApplyChange={(v) => setBulkActualApply({ ...bulkActualApply, status: v })}
                  label={t('statusLabel')}
                >
                  <select
                    value={bulkActualValues.status}
                    onChange={(e) => setBulkActualValues({ ...bulkActualValues, status: e.target.value })}
                    className={nativeSelectClass}
                  >
                    {Object.entries(TASK_STATUSES).map(([key, label]) => (
                      <option key={key} value={key}>{label}</option>
                    ))}
                  </select>
                </ApplyFieldRow>
                <ApplyFieldRow
                  apply={bulkActualApply.progressRate}
                  onApplyChange={(v) => setBulkActualApply({ ...bulkActualApply, progressRate: v })}
                  label={t('progressRatePercent')}
                >
                  <NumberInput
                    min={1}
                    max={100}
                    value={bulkActualValues.progressRate}
                    onChange={(n) => setBulkActualValues({ ...bulkActualValues, progressRate: n })}
                  />
                </ApplyFieldRow>
                <ApplyFieldRow
                  apply={bulkActualApply.actualStartDate}
                  onApplyChange={(v) => setBulkActualApply({ ...bulkActualApply, actualStartDate: v })}
                  label={t('actualStartDate')}
                >
                  <DateFieldWithActions
                    value={bulkActualValues.actualStartDate}
                    onChange={(v) => setBulkActualValues({ ...bulkActualValues, actualStartDate: v })}
                  />
                </ApplyFieldRow>
                <ApplyFieldRow
                  apply={bulkActualApply.actualEndDate}
                  onApplyChange={(v) => setBulkActualApply({ ...bulkActualApply, actualEndDate: v })}
                  label={t('actualEndDate')}
                >
                  <DateFieldWithActions
                    value={bulkActualValues.actualEndDate}
                    onChange={(v) => setBulkActualValues({ ...bulkActualValues, actualEndDate: v })}
                  />
                </ApplyFieldRow>
                <Button type="submit" className="w-full">{t('bulkApply')}</Button>
              </form>
            </DialogContent>
          </Dialog>
          {canEditPmTl && (
            <Button variant="outline" size="sm" className="text-destructive" onClick={handleBulkDelete}>{t('bulkDelete')}</Button>
          )}
          <Button variant="outline" size="sm" onClick={() => setSelectedIds(new Set())}>{t('deselectAll')}</Button>
        </div>
      )}

      {/*
        テーブルレイアウト方針（2026-04-17 再更新）:
        - 列統合（11 列 → 8 列）は維持
        - 通常 viewport (1280px+) では 1 画面に収めるが、狭い環境では overflow-x-auto で
          ラッパ内に横スクロールを閉じ込める（= page 全体の横スクロール・中央寄せ崩れを防止）
        - 以前あった「wrapper 右 border が overflowed テーブルの実績期間カラムを貫通して
          縦罫線に見える」バグは、overflow-x-auto でテーブル内にはみ出しを閉じ込めることで解消
        - 動的リサイズ: md 未満では font-size / padding を圧縮して情報を詰め込む
        - 日付・操作列の whitespace-nowrap は保持（「2026-」等の折返し防止）
        - 名称列のみ折返し許容（長い名前に対応）
      */}
      {/* PR #128a-2: PC (md+) は既存 Table + ResizableColumnsProvider を維持 (PC UX 変更なし) */}
      <div className="hidden md:block">
        <ResizableColumnsProvider tableKey="project-tasks">
          <div className="flex justify-end pb-2">
            <ResetColumnsButton />
          </div>
          <div className="rounded-lg border overflow-x-auto">
            <table className="min-w-full text-xs md:text-sm">
              <thead className="bg-muted">
                <tr>
                  {canSelectForProgress && (
                    <th className="px-1.5 py-1.5 md:px-2 md:py-2 w-8">
                      <input
                        type="checkbox"
                        checked={isAllSelected}
                        onChange={toggleSelectAll}
                        className="rounded"
                        title={t('selectAll')}
                      />
                    </th>
                  )}
                  {/* feat/wbs-overwrite-import: ID 列はトグル ON のときのみ表示 (CSV 整合確認用) */}
                  {showIdColumn && (
                    <ResizableHead columnKey="id" defaultWidth={300}>ID</ResizableHead>
                  )}
                  <ResizableHead columnKey="name" defaultWidth={320}>{t('columnName')}</ResizableHead>
                  <ResizableHead columnKey="assignee" defaultWidth={140}>{t('columnAssignee')}</ResizableHead>
                  <ResizableHead columnKey="status" defaultWidth={100}>{t('columnStatus')}</ResizableHead>
                  <ResizableHead columnKey="progress" defaultWidth={140}>{t('columnProgressEffort')}</ResizableHead>
                  <ResizableHead columnKey="plannedRange" defaultWidth={180}>{t('columnPlannedRange')}</ResizableHead>
                  <ResizableHead columnKey="actualRange" defaultWidth={180}>{t('columnActualRange')}</ResizableHead>
                  {/* PR #168: 添付列 */}
                  <ResizableHead columnKey="attachments" defaultWidth={200}>{t('columnAttachments')}</ResizableHead>
                  <ResizableHead columnKey="actions" defaultWidth={100}>{t('columnActions')}</ResizableHead>
                </tr>
              </thead>
              <tbody>
                {filteredTasks.map((task) => (
                  <TaskTreeNode
                    key={task.id}
                    task={task}
                    depth={0}
                    canEditPmTl={canEditPmTl}
                    canSelectForProgress={canSelectForProgress}
                    userId={userId}
                    projectId={projectId}
                    reload={reload}
                    onLoading={withLoading}
                    isSelected={selectedIds.has(task.id)}
                    selectedIds={selectedIds}
                    onToggleSelect={toggleSelect}
                    members={members}
                    parentOptions={parentOptions}
                    onEditClick={openEditDialog}
                    expandedTaskIds={expandedTaskIds}
                    onToggleExpanded={toggleExpanded}
                    showIdColumn={showIdColumn}
                    attachmentsByEntity={attachmentsByEntity}
                  />
                ))}
                {filteredTasks.length === 0 && (
                  <tr>
                    {/* PR #168: 添付列追加に伴い colSpan +1 */}
                    <td colSpan={(canSelectForProgress ? 9 : 8) + (showIdColumn ? 1 : 0)} className="py-8 text-center text-muted-foreground">
                      {tasks.length === 0
                        ? t('noTasks')
                        : t('noFilteredTasks')}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </ResizableColumnsProvider>
      </div>

      {/* PR #128a-2: モバイル (md 未満) 専用のカード形式 WBS ビュー
          階層は marginLeft で字下げ表示、Expand/Collapse は PC と同じ state を共有、
          編集は既存ダイアログに誘導 (新規実装なし)。一括選択 / bulk update / ショートカットは提供しない。 */}
      <div className="space-y-2 md:hidden" role="list" aria-label={t('mobileListAria')}>
        {filteredTasks.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            {tasks.length === 0
              ? t('noTasks')
              : t('noFilteredTasks')}
          </p>
        ) : (
          filteredTasks.map((task) => (
            <TaskMobileCard
              key={task.id}
              task={task}
              depth={0}
              canEditPmTl={canEditPmTl}
              userId={userId}
              projectId={projectId}
              reload={reload}
              onLoading={withLoading}
              members={members}
              parentOptions={parentOptions}
              onEditClick={openEditDialog}
              expandedTaskIds={expandedTaskIds}
              onToggleExpanded={toggleExpanded}
              attachmentsByEntity={attachmentsByEntity}
            />
          ))
        )}
      </div>

      {/* 編集ダイアログ: ロールに応じて PM/TL 編集項目・実績項目を出し分ける */}
      {/* PR #87: 実績項目セクションが grid-cols-2 のため max-w-[min(90vw,36rem)] (36rem) では日付列が
          狭く「日付を選択」が 1 文字ずつ縦組みになる UI 崩れが起きていた。max-w-[min(90vw,42rem)] (42rem)
          に拡大して 2 列でも十分な width を確保する。 */}
      <Dialog open={editingTask != null} onOpenChange={(open) => { if (!open) closeEditDialog(); }}>
        <DialogContent className="max-w-[min(90vw,42rem)] max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editingTask?.type === 'work_package' ? t('editWorkPackageTitle') : t('editActivityTitle')}
            </DialogTitle>
            <DialogDescription>
              {editingCanUpdatePm && editingCanUpdateActual
                ? t('editDescriptionBoth')
                : editingCanUpdatePm
                ? t('editDescriptionPm')
                : t('editDescriptionActual')}
            </DialogDescription>
          </DialogHeader>
          {editingTask && editForm && (
            <form onSubmit={handleEditDialogSubmit} className="space-y-4">
              {editError && <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{editError}</div>}

              {/* PM/TL 編集セクション */}
              {editingCanUpdatePm && (
                <section className="space-y-3 rounded-md border border-border p-3">
                  <h4 className="text-sm font-medium text-foreground">{t('editSectionPm')}</h4>
                  <div className="space-y-2">
                    <Label>{t('type')}</Label>
                    <select
                      value={editForm.type}
                      onChange={(e) => setEditForm({ ...editForm, type: e.target.value as 'work_package' | 'activity' })}
                      className={nativeSelectClass}
                    >
                      {Object.entries(WBS_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                    </select>
                  </div>
                  <div className="space-y-2">
                    <Label>{t('parentWp')}</Label>
                    <select
                      value={editForm.parentTaskId}
                      onChange={(e) => setEditForm({ ...editForm, parentTaskId: e.target.value })}
                      className={nativeSelectClass}
                    >
                      <option value="">{t('noParentTopLevel')}</option>
                      {parentOptions.filter((p) => p.id !== editingTask.id).map((p) => (
                        <option key={p.id} value={p.id}>{p.label}</option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-2">
                    <Label>{t('columnName')}</Label>
                    <Input value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} required />
                  </div>
                  {editForm.type === 'activity' && (
                    <>
                      <div className="space-y-2">
                        <Label>{t('columnAssignee')}</Label>
                        <select
                          value={editForm.assigneeId}
                          onChange={(e) => setEditForm({ ...editForm, assigneeId: e.target.value })}
                          className={nativeSelectClass}
                        >
                          <option value="">{t('notSet')}</option>
                          {members.map((m) => (
                            <option key={m.userId} value={m.userId}>{m.userName}</option>
                          ))}
                        </select>
                      </div>
                      {/* PR #88: 予定開始/終了日は一括編集画面と同様に 1 行ごとの
                          縦並びに変更 (grid-cols-2 では狭い画面で日付ボタン群が
                          flex-wrap で崩れるため)。 */}
                      <div className="space-y-2">
                        <Label>{t('plannedStartDate')}</Label>
                        <DateFieldWithActions value={editForm.plannedStartDate} onChange={(v) => setEditForm({ ...editForm, plannedStartDate: v })} />
                      </div>
                      <div className="space-y-2">
                        <Label>{t('plannedEndDate')}</Label>
                        <DateFieldWithActions value={editForm.plannedEndDate} onChange={(v) => setEditForm({ ...editForm, plannedEndDate: v })} />
                      </div>
                      <div className="space-y-2">
                        <Label>{t('estimatedEffort')}</Label>
                        <NumberInput min={1} step={0.5} value={editForm.plannedEffort} onChange={(n) => setEditForm({ ...editForm, plannedEffort: n })} />
                      </div>
                    </>
                  )}
                </section>
              )}

              {/* 実績セクション（PM/TL または ACT の担当者本人のみ）*/}
              {editingCanUpdateActual && editForm.type === 'activity' && (
                <section className="space-y-3 rounded-md border border-border p-3">
                  <h4 className="text-sm font-medium text-foreground">{t('editSectionActual')}</h4>
                  <div className="space-y-2">
                    <Label>{t('statusLabel')}</Label>
                    <select
                      value={editForm.status}
                      onChange={(e) => {
                        const v = e.target.value;
                        const next = { ...editForm, status: v };
                        // 整合性ルール: 未着手→両クリア、完了以外→実績終了クリア
                        if (v === 'not_started') { next.actualStartDate = ''; next.actualEndDate = ''; }
                        else if (v !== 'completed') { next.actualEndDate = ''; }
                        // status=完了 → 進捗 100% (既存ルール、UI 側でも即反映)
                        if (v === 'completed') { next.progressRate = 100; }
                        setEditForm(next);
                      }}
                      className={nativeSelectClass}
                    >
                      {Object.entries(TASK_STATUSES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                    </select>
                  </div>
                  <div className="space-y-2">
                    <Label>{t('progressRate')}</Label>
                    <NumberInput
                      min={1}
                      max={100}
                      value={editForm.progressRate}
                      onChange={(n) => {
                        // PR #69 Task 1: 進捗 100% → ステータス=完了 を UI でも即強制
                        const next = { ...editForm, progressRate: n };
                        if (n === 100 && editForm.status !== 'completed') {
                          next.status = 'completed';
                        }
                        setEditForm(next);
                      }}
                    />
                  </div>
                  {/* PR #88: 実績開始/終了日も縦並びに統一 (一括実績更新画面と同じ UX)。 */}
                  <div className="space-y-2">
                    <Label className={editingActualStartDisabled ? 'text-muted-foreground' : ''}>{t('actualStartDate')}</Label>
                    <DateFieldWithActions
                      value={editForm.actualStartDate}
                      onChange={(v) => setEditForm({ ...editForm, actualStartDate: v })}
                      disabled={editingActualStartDisabled}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label className={editingActualEndDisabled ? 'text-muted-foreground' : ''}>{t('actualEndDate')}</Label>
                    <DateFieldWithActions
                      value={editForm.actualEndDate}
                      onChange={(v) => setEditForm({ ...editForm, actualEndDate: v })}
                      disabled={editingActualEndDisabled}
                    />
                  </div>
                </section>
              )}

              {/* PR #64 Phase 2: 成果物・設計書・仕様書リンク (複数) */}
              <AttachmentList
                entityType="task"
                entityId={editingTask.id}
                canEdit={canEditPmTl}
                label={tAttachment('relatedUrl')}
              />

              <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" onClick={closeEditDialog}>{tAction('cancel')}</Button>
                <Button type="submit">{tAction('save')}</Button>
              </div>
            </form>
          )}
        </DialogContent>
      </Dialog>

      {/* feat/wbs-overwrite-import: WBS 上書きインポート ダイアログ */}
      <WbsSyncImportDialog
        projectId={projectId}
        open={isSyncImportOpen}
        onOpenChange={setIsSyncImportOpen}
        onImported={reload}
      />
    </div>
  );
}
