'use client';

import { memo, useCallback, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
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
import { LabeledSelect } from '@/components/labeled-select';
import { collectAllIds, collectSelfAndDescendantIds } from '@/lib/task-tree-utils';
import { TASK_STATUSES, PRIORITIES, WBS_TYPES } from '@/types';
import type { TaskDTO } from '@/services/task.service';
import type { MemberDTO } from '@/services/member.service';

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

const statusColors: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  not_started: 'outline',
  in_progress: 'default',
  completed: 'secondary',
  on_hold: 'destructive',
};

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
  return (
    <div className="flex items-start gap-2">
      <input
        type="checkbox"
        checked={apply}
        onChange={(e) => onApplyChange(e.target.checked)}
        className="mt-2 rounded"
        aria-label={`${label}を一括更新する`}
      />
      <div className="flex-1 space-y-1">
        <Label className={apply ? 'text-sm' : 'text-sm text-gray-400'}>{label}</Label>
        <div className={apply ? '' : 'pointer-events-none opacity-50'}>{children}</div>
      </div>
    </div>
  );
}

type TaskTreeNodeProps = {
  task: TaskDTO;
  depth: number;
  canEditPmTl: boolean;
  userId: string;
  projectId: string;
  reload: () => Promise<void> | void;
  onLoading: <T>(fn: () => Promise<T>) => Promise<T>;
  isSelected: boolean;
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  members: MemberDTO[];
  parentOptions: { id: string; label: string }[];
};

function TaskTreeNodeImpl({
  task,
  depth,
  canEditPmTl,
  userId,
  projectId,
  reload,
  onLoading,
  isSelected,
  selectedIds,
  onToggleSelect,
  members,
  parentOptions,
}: TaskTreeNodeProps) {
  // PM/TL 用の編集フォーム
  const [showPmEdit, setShowPmEdit] = useState(false);
  const [pmEditForm, setPmEditForm] = useState({
    type: task.type as 'work_package' | 'activity',
    parentTaskId: task.parentTaskId ?? '',
    name: task.name,
    assigneeId: task.assigneeId ?? '',
    plannedStartDate: task.plannedStartDate,
    plannedEndDate: task.plannedEndDate,
    plannedEffort: task.plannedEffort,
  });

  // メンバー用の編集フォーム（実績）
  const [showMemberEdit, setShowMemberEdit] = useState(false);
  const [memberEditForm, setMemberEditForm] = useState({
    status: task.status,
    progressRate: task.progressRate,
    actualStartDate: task.actualStartDate ?? '',
    actualEndDate: task.actualEndDate ?? '',
  });

  // メンバーが編集する表示値（即時反映用）。
  // かつ 親 task prop の変更（CRUD 後の reload / WP 集計の再計算など）にも自動追従する。
  // React 公式パターン: https://react.dev/reference/react/useState#storing-information-from-previous-renders
  const [displayStatus, setDisplayStatus] = useState(task.status);
  const [displayProgressRate, setDisplayProgressRate] = useState(task.progressRate);
  const [displayActualStartDate, setDisplayActualStartDate] = useState(task.actualStartDate);
  const [displayActualEndDate, setDisplayActualEndDate] = useState(task.actualEndDate);
  // 前回レンダーで観測した task prop の値。変化検知用に保持。
  const [prevTaskSnapshot, setPrevTaskSnapshot] = useState({
    status: task.status,
    progressRate: task.progressRate,
    actualStartDate: task.actualStartDate,
    actualEndDate: task.actualEndDate,
  });
  if (
    task.status !== prevTaskSnapshot.status
    || task.progressRate !== prevTaskSnapshot.progressRate
    || task.actualStartDate !== prevTaskSnapshot.actualStartDate
    || task.actualEndDate !== prevTaskSnapshot.actualEndDate
  ) {
    // 親からの task prop が変わった（reload 後 / 親 WP 集計再計算など）→
    // display state をサーバの新しい値に追従させる。
    setPrevTaskSnapshot({
      status: task.status,
      progressRate: task.progressRate,
      actualStartDate: task.actualStartDate,
      actualEndDate: task.actualEndDate,
    });
    setDisplayStatus(task.status);
    setDisplayProgressRate(task.progressRate);
    setDisplayActualStartDate(task.actualStartDate);
    setDisplayActualEndDate(task.actualEndDate);
  }

  const isWP = task.type === 'work_package';
  const hasChildren = task.children && task.children.length > 0;
  const [isCollapsed, setIsCollapsed] = useState(isWP && hasChildren ? true : false);
  const isAssignee = task.assigneeId === userId;
  // メンバー編集: 担当者のみ（ACT限定）
  const canMemberEdit = !isWP && isAssignee;

  async function handlePmEditSubmit(e: React.FormEvent) {
    e.preventDefault();
    const body: Record<string, unknown> = {
      type: pmEditForm.type,
      name: pmEditForm.name,
      parentTaskId: pmEditForm.parentTaskId || null,
    };
    if (pmEditForm.type === 'activity') {
      body.assigneeId = pmEditForm.assigneeId || null;
      body.plannedStartDate = pmEditForm.plannedStartDate;
      body.plannedEndDate = pmEditForm.plannedEndDate;
      body.plannedEffort = pmEditForm.plannedEffort;
    }
    await onLoading(() =>
      fetch(`/api/projects/${projectId}/tasks/${task.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
    setShowPmEdit(false);
    await reload();
  }

  async function handleMemberEditSubmit(e: React.FormEvent) {
    e.preventDefault();
    const res = await onLoading(() =>
      fetch(`/api/projects/${projectId}/tasks/${task.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: memberEditForm.status,
          progressRate: memberEditForm.progressRate,
          actualStartDate: memberEditForm.actualStartDate || null,
          actualEndDate: memberEditForm.actualEndDate || null,
        }),
      }),
    );
    if (res.ok) {
      // 画面表示を即時反映
      setDisplayStatus(memberEditForm.status);
      setDisplayProgressRate(memberEditForm.progressRate);
      setDisplayActualStartDate(memberEditForm.actualStartDate || null);
      setDisplayActualEndDate(memberEditForm.actualEndDate || null);
    }
    setShowMemberEdit(false);
    await reload();
  }

  const colSpan = canEditPmTl ? 11 : 10;

  return (
    <>
      <tr className={`border-b hover:bg-gray-50 ${isWP ? 'bg-gray-50/50' : ''}`}>
        {canEditPmTl && (
          <td className="px-2 py-2 w-8">
            <input type="checkbox" checked={isSelected} onChange={() => onToggleSelect(task.id)} className="rounded" />
          </td>
        )}
        <td className="px-3 py-2" style={{ paddingLeft: `${depth * 24 + 12}px` }}>
          <div className="flex items-center gap-2">
            {isWP && hasChildren ? (
              <button
                type="button"
                onClick={() => setIsCollapsed(!isCollapsed)}
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-gray-500 hover:bg-gray-200"
                title={isCollapsed ? '展開' : '折りたたみ'}
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
              <span className="text-xs text-gray-400">{task.wbsNumber}</span>
            )}
            {isWP && hasChildren && isCollapsed && (
              <span className="text-xs text-gray-400">({task.children!.length})</span>
            )}
          </div>
        </td>
        <td className="px-3 py-2 text-sm whitespace-nowrap">{isWP ? '-' : (task.assigneeName || '-')}</td>
        <td className="px-3 py-2 whitespace-nowrap">
          <Badge variant={statusColors[displayStatus] || 'outline'}>
            {TASK_STATUSES[displayStatus as keyof typeof TASK_STATUSES] || displayStatus}
          </Badge>
        </td>
        <td className="px-3 py-2 text-sm whitespace-nowrap">
          <div className="flex items-center gap-2">
            <div className="h-2 w-16 rounded-full bg-gray-200">
              <div
                className="h-2 rounded-full bg-blue-500"
                style={{ width: `${displayProgressRate}%` }}
              />
            </div>
            <span>{displayProgressRate}%</span>
          </div>
        </td>
        <td className="px-3 py-2 text-sm whitespace-nowrap">{task.plannedEffort > 0 ? task.plannedEffort : '-'}</td>
        <td className="px-3 py-2 text-sm whitespace-nowrap">{task.plannedStartDate || '-'}</td>
        <td className="px-3 py-2 text-sm whitespace-nowrap">{task.plannedEndDate || '-'}</td>
        <td className="px-3 py-2 text-sm whitespace-nowrap">{displayActualStartDate || '-'}</td>
        <td className="px-3 py-2 text-sm whitespace-nowrap">{displayActualEndDate || '-'}</td>
        <td className="px-3 py-2 whitespace-nowrap">
          <div className="flex gap-1">
            {canMemberEdit && (
              <Button variant="outline" size="sm" onClick={() => setShowMemberEdit(!showMemberEdit)}>
                実績
              </Button>
            )}
            {canEditPmTl && (
              <Button variant="outline" size="sm" onClick={() => setShowPmEdit(!showPmEdit)}>編集</Button>
            )}
            {canEditPmTl && (
              <Button
                variant="outline"
                size="sm"
                className="text-red-600 hover:text-red-700"
                onClick={async () => {
                  const label = isWP ? 'ワークパッケージ' : 'アクティビティ';
                  if (!confirm(`この${label}を削除しますか？`)) return;
                  await onLoading(() =>
                    fetch(`/api/projects/${projectId}/tasks/${task.id}`, { method: 'DELETE' }),
                  );
                  await reload();
                }}
              >
                削除
              </Button>
            )}
          </div>
        </td>
      </tr>
      {/* メンバー編集フォーム: ステータス・進捗率・実績開始日・実績終了日
          ステータス整合性ルール:
          - 未着手: 実績開始/終了とも入力不可（送信時もサーバ側で null に正規化）
          - 進行中/保留: 実績開始のみ入力可、実績終了は入力不可
          - 完了: 両方入力可 */}
      {showMemberEdit && canMemberEdit && (() => {
        const actualStartDisabled = memberEditForm.status === 'not_started';
        const actualEndDisabled = memberEditForm.status !== 'completed';
        return (
          <tr className="border-b bg-blue-50">
            <td colSpan={colSpan} className="px-6 py-3">
              <form onSubmit={handleMemberEditSubmit} className="flex items-end gap-4">
                <div className="space-y-1">
                  <Label className="text-xs">ステータス</Label>
                  <LabeledSelect
                    value={memberEditForm.status}
                    onValueChange={(v) => {
                      if (!v) return;
                      // ステータス変更時に実績日付をルールに合わせてクリア
                      const next = { ...memberEditForm, status: v };
                      if (v === 'not_started') {
                        next.actualStartDate = '';
                        next.actualEndDate = '';
                      } else if (v !== 'completed') {
                        next.actualEndDate = '';
                      }
                      setMemberEditForm(next);
                    }}
                    options={TASK_STATUSES}
                    className="w-28"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">進捗率</Label>
                  <NumberInput min={1} max={100} value={memberEditForm.progressRate} onChange={(n) => setMemberEditForm({ ...memberEditForm, progressRate: n })} className="w-20" />
                </div>
                <div className="space-y-1">
                  <Label className={`text-xs ${actualStartDisabled ? 'text-gray-400' : ''}`}>開始日（実績）</Label>
                  <Input
                    type="date"
                    value={memberEditForm.actualStartDate}
                    onChange={(e) => setMemberEditForm({ ...memberEditForm, actualStartDate: e.target.value })}
                    className="w-36"
                    disabled={actualStartDisabled}
                    title={actualStartDisabled ? '未着手のタスクには実績開始日を入力できません' : undefined}
                  />
                </div>
                <div className="space-y-1">
                  <Label className={`text-xs ${actualEndDisabled ? 'text-gray-400' : ''}`}>終了日（実績）</Label>
                  <Input
                    type="date"
                    value={memberEditForm.actualEndDate}
                    onChange={(e) => setMemberEditForm({ ...memberEditForm, actualEndDate: e.target.value })}
                    className="w-36"
                    disabled={actualEndDisabled}
                    title={actualEndDisabled ? '完了状態のタスクのみ実績終了日を入力できます' : undefined}
                  />
                </div>
                <Button type="submit" size="sm">更新</Button>
                <Button type="button" variant="outline" size="sm" onClick={() => setShowMemberEdit(false)}>閉じる</Button>
              </form>
            </td>
          </tr>
        );
      })()}
      {/* PM/TL 編集フォーム */}
      {showPmEdit && (
        <tr className="border-b bg-green-50">
          <td colSpan={colSpan} className="px-6 py-3">
            <form onSubmit={handlePmEditSubmit} className="space-y-3">
              <div className="flex flex-wrap items-end gap-4">
                <div className="space-y-1">
                  <Label className="text-xs">種別</Label>
                  <LabeledSelect
                    value={pmEditForm.type}
                    onValueChange={(v) => v && setPmEditForm({ ...pmEditForm, type: v as 'work_package' | 'activity' })}
                    options={WBS_TYPES}
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">親WP</Label>
                  <LabeledSelect
                    value={pmEditForm.parentTaskId}
                    onValueChange={(v) => setPmEditForm({ ...pmEditForm, parentTaskId: v ?? '' })}
                    options={Object.fromEntries(parentOptions.filter((p) => p.id !== task.id).map((p) => [p.id, p.label]))}
                    placeholder="なし（最上位）"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">名前</Label>
                  <Input value={pmEditForm.name} onChange={(e) => setPmEditForm({ ...pmEditForm, name: e.target.value })} className="w-48" required />
                </div>
              </div>
              {pmEditForm.type === 'activity' && (
                <div className="flex flex-wrap items-end gap-4">
                  <div className="space-y-1">
                    <Label className="text-xs">担当者</Label>
                    <LabeledSelect
                      value={pmEditForm.assigneeId}
                      onValueChange={(v) => setPmEditForm({ ...pmEditForm, assigneeId: v ?? '' })}
                      options={Object.fromEntries(members.map((m) => [m.userId, m.userName]))}
                      placeholder="未設定"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">予定開始日</Label>
                    <Input type="date" value={pmEditForm.plannedStartDate ?? ''} onChange={(e) => setPmEditForm({ ...pmEditForm, plannedStartDate: e.target.value })} className="w-36" />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">予定終了日</Label>
                    <Input type="date" value={pmEditForm.plannedEndDate ?? ''} onChange={(e) => setPmEditForm({ ...pmEditForm, plannedEndDate: e.target.value })} className="w-36" />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">見積工数</Label>
                    <NumberInput min={1} step={0.5} value={pmEditForm.plannedEffort} onChange={(n) => setPmEditForm({ ...pmEditForm, plannedEffort: n })} className="w-24" />
                  </div>
                </div>
              )}
              <div className="flex gap-2">
                <Button type="submit" size="sm">保存</Button>
                <Button type="button" variant="outline" size="sm" onClick={() => setShowPmEdit(false)}>閉じる</Button>
              </div>
            </form>
          </td>
        </tr>
      )}
      {!isCollapsed && task.children?.map((child) => (
        <TaskTreeNode
          key={child.id}
          task={child}
          depth={depth + 1}
          canEditPmTl={canEditPmTl}
          userId={userId}
          projectId={projectId}
          reload={reload}
          onLoading={onLoading}
          isSelected={selectedIds.has(child.id)}
          selectedIds={selectedIds}
          onToggleSelect={onToggleSelect}
          members={members}
          parentOptions={parentOptions}
        />
      ))}
    </>
  );
}

/**
 * メモ化: 親ツリーの state 変化（他ノードの編集フォーム開閉や選択状態変更など）で
 * このノード自身に関係ない再描画を抑制する。
 * selectedIds は参照が変わる Set なので比較対象から外し、代わりに親で算出した isSelected（boolean）で判定する。
 */
const TaskTreeNode = memo(TaskTreeNodeImpl, (prev, next) =>
  prev.task === next.task
  && prev.depth === next.depth
  && prev.canEditPmTl === next.canEditPmTl
  && prev.userId === next.userId
  && prev.projectId === next.projectId
  && prev.reload === next.reload
  && prev.onLoading === next.onLoading
  && prev.isSelected === next.isSelected
  && prev.onToggleSelect === next.onToggleSelect
  && prev.members === next.members
  && prev.parentOptions === next.parentOptions,
);

export function TasksClient({ projectId, tasks, members, projectRole, systemRole, userId, onReload }: Props) {
  const router = useRouter();
  const { withLoading } = useLoading();
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [error, setError] = useState('');

  // 親から渡された遅延フェッチ再取得ハンドラ。未指定時は router.refresh() にフォールバック。
  const reload = useCallback(async () => {
    if (onReload) {
      await onReload();
    } else {
      router.refresh();
    }
  }, [onReload, router]);

  const canEditPmTl = systemRole === 'admin' || projectRole === 'pm_tl';
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // 全タスクIDの一覧（全選択用）
  const allTaskIds = useMemo(() => collectAllIds(tasks), [tasks]);

  const isAllSelected = allTaskIds.length > 0 && allTaskIds.every((id) => selectedIds.has(id));

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
  const [isBulkEditOpen, setIsBulkEditOpen] = useState(false);
  const [bulkEditApply, setBulkEditApply] = useState({
    assigneeId: false,
    priority: false,
    plannedStartDate: false,
    plannedEndDate: false,
    plannedEffort: false,
  });
  const [bulkEditValues, setBulkEditValues] = useState({
    assigneeId: '',
    priority: 'medium',
    plannedStartDate: '',
    plannedEndDate: '',
    plannedEffort: 0,
  });
  const [bulkEditError, setBulkEditError] = useState('');

  // --- 一括実績更新（メンバー 実績フォーム相当）ダイアログ ---
  const [isBulkActualOpen, setIsBulkActualOpen] = useState(false);
  const [bulkActualApply, setBulkActualApply] = useState({
    status: false,
    progressRate: false,
    actualStartDate: false,
    actualEndDate: false,
  });
  const [bulkActualValues, setBulkActualValues] = useState({
    status: 'not_started',
    progressRate: 0,
    actualStartDate: '',
    actualEndDate: '',
  });
  const [bulkActualError, setBulkActualError] = useState('');

  async function handleBulkDelete() {
    if (selectedIds.size === 0) return;
    if (!confirm(`${selectedIds.size} 件を一括削除しますか？`)) return;
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
    if (selectedIds.size === 0) return '対象タスクがありません';
    if (Object.keys(updates).length === 0) return '更新項目を1つ以上選択してください';

    const res = await withLoading(() =>
      fetch(`/api/projects/${projectId}/tasks/bulk-update`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskIds: [...selectedIds], ...updates }),
      }),
    );
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      return json.error?.message || json.error?.details?.[0]?.message || '一括更新に失敗しました';
    }
    return null;
  }

  async function handleBulkEditSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBulkEditError('');
    const updates: Record<string, unknown> = {};
    if (bulkEditApply.assigneeId) updates.assigneeId = bulkEditValues.assigneeId || null;
    if (bulkEditApply.priority) updates.priority = bulkEditValues.priority;
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
    setBulkEditApply({
      assigneeId: false,
      priority: false,
      plannedStartDate: false,
      plannedEndDate: false,
      plannedEffort: false,
    });
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
    setBulkActualApply({
      status: false,
      progressRate: false,
      actualStartDate: false,
      actualEndDate: false,
    });
    await reload();
  }

  // --- WBS テンプレートエクスポート (CSV) ---
  async function handleExport() {
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
    // BOM 付き UTF-8 で Excel 対応
    const bom = '\uFEFF';
    const blob = new Blob([bom + csvText], { type: 'text/csv; charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `wbs-template-${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // --- WBS テンプレートインポート (CSV) ---
  const [isImportOpen, setIsImportOpen] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importError, setImportError] = useState('');

  async function handleImport(e: React.FormEvent) {
    e.preventDefault();
    setImportError('');
    if (!importFile) { setImportError('ファイルを選択してください'); return; }

    // 多くの環境で挙動が安定する multipart/form-data で送信。
    // （以前の `text/csv` 生 body は Vercel 側のルーティング / edge 層で
    //   ERR_CONNECTION_RESET を誘発するケースが観測されたため）
    const formData = new FormData();
    formData.append('file', importFile);

    const res = await withLoading(() =>
      fetch(`/api/projects/${projectId}/tasks/import`, {
        method: 'POST',
        // Content-Type は boundary 付きで自動設定されるため明示しない
        body: formData,
      }),
    );

    if (!res.ok) {
      // サーバから JSON エラーレスポンスが返らない場合（接続切断等）にも
      // ユーザに原因を提示できるよう text() でフォールバックする
      let message = 'インポートに失敗しました';
      try {
        const json = await res.json();
        message = json.error?.message || json.error?.details?.[0]?.message || message;
      } catch {
        const text = await res.text().catch(() => '');
        if (text) message = text.slice(0, 200);
      }
      setImportError(message);
      return;
    }

    setIsImportOpen(false);
    setImportFile(null);
    await reload();
  }

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
    assigneeId: '',
    plannedStartDate: '',
    plannedEndDate: '',
    plannedEffort: 0,
    priority: 'medium',
  });

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError('');

    const base = createType === 'work_package'
      ? { type: 'work_package', name: form.name }
      : {
          type: 'activity',
          name: form.name,
          assigneeId: form.assigneeId,
          plannedStartDate: form.plannedStartDate,
          plannedEndDate: form.plannedEndDate,
          plannedEffort: form.plannedEffort,
          priority: form.priority,
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
      setError(json.error?.message || json.error?.details?.[0]?.message || '作成に失敗しました');
      return;
    }

    setIsCreateOpen(false);
    setParentTaskId('');
    setForm({ name: '', assigneeId: '', plannedStartDate: '', plannedEndDate: '', plannedEffort: 0, priority: 'medium' });
    await reload();
  }

  // Dialog 内のセレクト用スタイル（native select — base-ui Select は Dialog Portal と干渉するため）
  const nativeSelectClass = 'flex h-8 w-full items-center rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50';

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">WBS管理</h2>
        {canEditPmTl && (
          <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={handleExport}>
            {selectedIds.size > 0 ? `エクスポート(${selectedIds.size}件)` : 'エクスポート'}
          </Button>
          <Dialog open={isImportOpen} onOpenChange={setIsImportOpen}>
            <DialogTrigger render={<Button variant="outline" size="sm" />}>インポート</DialogTrigger>
            <DialogContent className="max-w-md">
              <DialogHeader>
                <DialogTitle>WBS テンプレートインポート</DialogTitle>
                <DialogDescription>エクスポートした CSV ファイルを Excel 等で編集し、インポートします。担当者・進捗は初期状態で作成されます。</DialogDescription>
              </DialogHeader>
              <form onSubmit={handleImport} className="space-y-4">
                {importError && <div className="rounded-md bg-red-50 p-3 text-sm text-red-600">{importError}</div>}
                <div className="space-y-2">
                  <Label>テンプレートファイル（CSV）</Label>
                  <Input type="file" accept=".csv" onChange={(e) => setImportFile(e.target.files?.[0] ?? null)} />
                </div>
                <Button type="submit" className="w-full">インポート実行</Button>
              </form>
            </DialogContent>
          </Dialog>
          <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
            <DialogTrigger render={<Button size="sm" />}>追加</DialogTrigger>
            <DialogContent className="max-w-lg">
              <DialogHeader>
                <DialogTitle>{createType === 'work_package' ? 'ワークパッケージ作成' : 'アクティビティ作成'}</DialogTitle>
                <DialogDescription>
                  {createType === 'work_package'
                    ? 'WBS の構造ノードを作成します。工数・日程は子要素から自動集計されます。'
                    : '実作業を登録します。担当者・日程・工数を入力してください。'}
                </DialogDescription>
              </DialogHeader>
              <form onSubmit={handleCreate} className="space-y-4">
                {error && (
                  <div className="rounded-md bg-red-50 p-3 text-sm text-red-600">{error}</div>
                )}
                <div className="space-y-2">
                  <Label>種別</Label>
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
                  <Label>親ワークパッケージ</Label>
                  <select
                    value={parentTaskId}
                    onChange={(e) => setParentTaskId(e.target.value)}
                    className={nativeSelectClass}
                  >
                    <option value="">なし（最上位に配置）</option>
                    {parentOptions.map((p) => (
                      <option key={p.id} value={p.id}>{p.label}</option>
                    ))}
                  </select>
                </div>
                <div className="space-y-2">
                  <Label>名称</Label>
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
                      <Label>担当者</Label>
                      {members.length === 0 ? (
                        <p className="text-sm text-red-500">メンバーが未登録です。先にメンバー管理から追加してください。</p>
                      ) : (
                        <select
                          value={form.assigneeId}
                          onChange={(e) => setForm({ ...form, assigneeId: e.target.value })}
                          className={nativeSelectClass}
                          required
                        >
                          <option value="">選択...</option>
                          {members.map((m) => (
                            <option key={m.userId} value={m.userId}>{m.userName}</option>
                          ))}
                        </select>
                      )}
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label>開始予定日</Label>
                        <Input type="date" value={form.plannedStartDate} onChange={(e) => setForm({ ...form, plannedStartDate: e.target.value })} required />
                      </div>
                      <div className="space-y-2">
                        <Label>終了予定日</Label>
                        <Input type="date" value={form.plannedEndDate} onChange={(e) => setForm({ ...form, plannedEndDate: e.target.value })} required />
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label>予定工数（人時）</Label>
                        <NumberInput min={1} step={0.5} value={form.plannedEffort} onChange={(n) => setForm({ ...form, plannedEffort: n })} required />
                      </div>
                      <div className="space-y-2">
                        <Label>優先度</Label>
                        <select
                          value={form.priority}
                          onChange={(e) => setForm({ ...form, priority: e.target.value })}
                          className={nativeSelectClass}
                        >
                          {Object.entries(PRIORITIES).map(([key, label]) => (
                            <option key={key} value={key}>{label}</option>
                          ))}
                        </select>
                      </div>
                    </div>
                  </>
                )}

                <Button type="submit" className="w-full">
                  作成
                </Button>
              </form>
            </DialogContent>
          </Dialog>
          </div>
        )}
      </div>

      {canEditPmTl && selectedIds.size > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-blue-200 bg-blue-50 px-4 py-2">
          <span className="text-sm font-medium">{selectedIds.size} 件選択中</span>
          <Dialog open={isBulkEditOpen} onOpenChange={setIsBulkEditOpen}>
            <DialogTrigger render={<Button variant="outline" size="sm" />}>一括編集</DialogTrigger>
            <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>一括編集（{selectedIds.size} 件）</DialogTitle>
                <DialogDescription>
                  適用する項目にチェックを入れて値を入力してください。WP は対象外（アクティビティのみ更新されます）。
                </DialogDescription>
              </DialogHeader>
              <form onSubmit={handleBulkEditSubmit} className="space-y-4">
                {bulkEditError && (
                  <div className="rounded-md bg-red-50 p-3 text-sm text-red-600">{bulkEditError}</div>
                )}
                <ApplyFieldRow
                  apply={bulkEditApply.assigneeId}
                  onApplyChange={(v) => setBulkEditApply({ ...bulkEditApply, assigneeId: v })}
                  label="担当者"
                >
                  <select
                    value={bulkEditValues.assigneeId}
                    onChange={(e) => setBulkEditValues({ ...bulkEditValues, assigneeId: e.target.value })}
                    className={nativeSelectClass}
                  >
                    <option value="">未設定</option>
                    {members.map((m) => (
                      <option key={m.userId} value={m.userId}>{m.userName}</option>
                    ))}
                  </select>
                </ApplyFieldRow>
                <ApplyFieldRow
                  apply={bulkEditApply.priority}
                  onApplyChange={(v) => setBulkEditApply({ ...bulkEditApply, priority: v })}
                  label="優先度"
                >
                  <select
                    value={bulkEditValues.priority}
                    onChange={(e) => setBulkEditValues({ ...bulkEditValues, priority: e.target.value })}
                    className={nativeSelectClass}
                  >
                    {Object.entries(PRIORITIES).map(([key, label]) => (
                      <option key={key} value={key}>{label}</option>
                    ))}
                  </select>
                </ApplyFieldRow>
                <ApplyFieldRow
                  apply={bulkEditApply.plannedStartDate}
                  onApplyChange={(v) => setBulkEditApply({ ...bulkEditApply, plannedStartDate: v })}
                  label="予定開始日"
                >
                  <Input
                    type="date"
                    value={bulkEditValues.plannedStartDate}
                    onChange={(e) => setBulkEditValues({ ...bulkEditValues, plannedStartDate: e.target.value })}
                  />
                </ApplyFieldRow>
                <ApplyFieldRow
                  apply={bulkEditApply.plannedEndDate}
                  onApplyChange={(v) => setBulkEditApply({ ...bulkEditApply, plannedEndDate: v })}
                  label="予定終了日"
                >
                  <Input
                    type="date"
                    value={bulkEditValues.plannedEndDate}
                    onChange={(e) => setBulkEditValues({ ...bulkEditValues, plannedEndDate: e.target.value })}
                  />
                </ApplyFieldRow>
                <ApplyFieldRow
                  apply={bulkEditApply.plannedEffort}
                  onApplyChange={(v) => setBulkEditApply({ ...bulkEditApply, plannedEffort: v })}
                  label="予定工数（人時）"
                >
                  <NumberInput
                    min={1}
                    step={0.5}
                    value={bulkEditValues.plannedEffort}
                    onChange={(n) => setBulkEditValues({ ...bulkEditValues, plannedEffort: n })}
                  />
                </ApplyFieldRow>
                <Button type="submit" className="w-full">一括適用</Button>
              </form>
            </DialogContent>
          </Dialog>
          <Dialog open={isBulkActualOpen} onOpenChange={setIsBulkActualOpen}>
            <DialogTrigger render={<Button variant="outline" size="sm" />}>一括実績更新</DialogTrigger>
            <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>一括実績更新（{selectedIds.size} 件）</DialogTitle>
                <DialogDescription>
                  適用する項目にチェックを入れて値を入力してください。WP は対象外（アクティビティのみ更新されます）。
                </DialogDescription>
              </DialogHeader>
              <form onSubmit={handleBulkActualSubmit} className="space-y-4">
                {bulkActualError && (
                  <div className="rounded-md bg-red-50 p-3 text-sm text-red-600">{bulkActualError}</div>
                )}
                <div className="rounded-md bg-gray-50 p-3 text-xs text-gray-600">
                  ステータス整合性ルール: 未着手なら実績開始/終了とも自動クリア、進行中/保留なら実績終了のみ自動クリア、完了のみ両方保存されます。
                </div>
                <ApplyFieldRow
                  apply={bulkActualApply.status}
                  onApplyChange={(v) => setBulkActualApply({ ...bulkActualApply, status: v })}
                  label="ステータス"
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
                  label="進捗率（%）"
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
                  label="実績開始日"
                >
                  <Input
                    type="date"
                    value={bulkActualValues.actualStartDate}
                    onChange={(e) => setBulkActualValues({ ...bulkActualValues, actualStartDate: e.target.value })}
                  />
                </ApplyFieldRow>
                <ApplyFieldRow
                  apply={bulkActualApply.actualEndDate}
                  onApplyChange={(v) => setBulkActualApply({ ...bulkActualApply, actualEndDate: v })}
                  label="実績終了日"
                >
                  <Input
                    type="date"
                    value={bulkActualValues.actualEndDate}
                    onChange={(e) => setBulkActualValues({ ...bulkActualValues, actualEndDate: e.target.value })}
                  />
                </ApplyFieldRow>
                <Button type="submit" className="w-full">一括適用</Button>
              </form>
            </DialogContent>
          </Dialog>
          <Button variant="outline" size="sm" className="text-red-600" onClick={handleBulkDelete}>一括削除</Button>
          <Button variant="outline" size="sm" onClick={() => setSelectedIds(new Set())}>選択解除</Button>
        </div>
      )}

      {/*
        テーブルレイアウト方針（2026-04-17）:
        - `min-w-full` で最低限コンテナ幅を埋めつつ、列数が多い場合は自然と幅が広がる
        - ユーザの最後の列（操作）が枠線に食い込む問題を、固定 `w-full` で列を圧縮せず
          content-based sizing に任せることで解消
        - 日付・操作列には `whitespace-nowrap` を付与し、「2026-」/「04-15」のような折返しを抑制
        - 名称列のみ `whitespace-normal` で長い名前の wrap を許容
        - 外枠の border + rounded-lg は視覚的区切りとして残し、`overflow-x-auto` でコンテンツが広いときは
          ユーザが横スクロールして全列を確認できる
      */}
      <div className="overflow-x-auto rounded-lg border">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50">
            <tr>
              {canEditPmTl && (
                <th className="px-2 py-2 w-8">
                  <input
                    type="checkbox"
                    checked={isAllSelected}
                    onChange={toggleSelectAll}
                    className="rounded"
                    title="全選択"
                  />
                </th>
              )}
              <th className="px-3 py-2 text-left font-medium">名称</th>
              <th className="px-3 py-2 text-left font-medium whitespace-nowrap">担当者</th>
              <th className="px-3 py-2 text-left font-medium whitespace-nowrap">ステータス</th>
              <th className="px-3 py-2 text-left font-medium whitespace-nowrap">進捗</th>
              <th className="px-3 py-2 text-left font-medium whitespace-nowrap">工数</th>
              <th className="px-3 py-2 text-left font-medium whitespace-nowrap">予定開始</th>
              <th className="px-3 py-2 text-left font-medium whitespace-nowrap">予定終了</th>
              <th className="px-3 py-2 text-left font-medium whitespace-nowrap">実績開始</th>
              <th className="px-3 py-2 text-left font-medium whitespace-nowrap">実績終了</th>
              <th className="px-3 py-2 text-left font-medium whitespace-nowrap">操作</th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((task) => (
              <TaskTreeNode
                key={task.id}
                task={task}
                depth={0}
                canEditPmTl={canEditPmTl}
                userId={userId}
                projectId={projectId}
                reload={reload}
                onLoading={withLoading}
                isSelected={selectedIds.has(task.id)}
                selectedIds={selectedIds}
                onToggleSelect={toggleSelect}
                members={members}
                parentOptions={parentOptions}
              />
            ))}
            {tasks.length === 0 && (
              <tr>
                <td colSpan={canEditPmTl ? 11 : 10} className="py-8 text-center text-gray-500">
                  WBS が登録されていません
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
