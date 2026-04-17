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
import { Pencil, Trash2 } from 'lucide-react';
import { collectAllIds, collectSelfAndDescendantIds } from '@/lib/task-tree-utils';
import { nativeSelectClass } from '@/components/ui/native-select-style';
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
  /** 編集アイコンクリック時に親 (TasksClient) の編集ダイアログを開くコールバック */
  onEditClick: (task: TaskDTO) => void;
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
  onEditClick,
}: TaskTreeNodeProps) {
  // 表示値は task prop を直接参照する。
  // 従来あったローカル display state（即時反映用）は、編集ダイアログ化に伴い廃止。
  // CRUD 後の reload + stale-while-revalidate（PR #33）で UI が追従する。

  const isWP = task.type === 'work_package';
  const hasChildren = task.children && task.children.length > 0;
  const [isCollapsed, setIsCollapsed] = useState(isWP && hasChildren ? true : false);
  const isAssignee = task.assigneeId === userId;
  // メンバー編集: 担当者のみ（ACT限定）
  const canMemberEdit = !isWP && isAssignee;
  const canOpenEdit = canEditPmTl || canMemberEdit;
  // 予定期間 / 実績期間の表示テキスト（片方しかない場合は "(未)" を反対側に挿入）
  const plannedRangeText = (() => {
    if (!task.plannedStartDate && !task.plannedEndDate) return '-';
    return `${task.plannedStartDate || '（未）'} 〜 ${task.plannedEndDate || '（未）'}`;
  })();
  const actualRangeText = (() => {
    if (!task.actualStartDate && !task.actualEndDate) return '-';
    return `${task.actualStartDate || '（未）'} 〜 ${task.actualEndDate || '（未）'}`;
  })();
  // 進捗&工数の表示: ACT は 進捗% / 工数h、WP は進捗%のみ（工数は子から集計済を表示）
  const effortText = task.plannedEffort > 0 ? `${task.plannedEffort}h` : null;
  void parentOptions;
  void members;

  return (
    <>
      <tr className={`border-b hover:bg-gray-50 ${isWP ? 'bg-gray-50/50' : ''}`}>
        {canEditPmTl && (
          <td className="px-1.5 py-1.5 md:px-2 md:py-2 w-8">
            <input type="checkbox" checked={isSelected} onChange={() => onToggleSelect(task.id)} className="rounded" />
          </td>
        )}
        <td className="px-1.5 py-1.5 md:px-3 md:py-2" style={{ paddingLeft: `${depth * 20 + 8}px` }}>
          <div className="flex items-center gap-1.5 md:gap-2">
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
        <td className="px-1.5 py-1.5 md:px-3 md:py-2 whitespace-nowrap">{isWP ? '-' : (task.assigneeName || '-')}</td>
        <td className="px-1.5 py-1.5 md:px-3 md:py-2 whitespace-nowrap">
          <Badge variant={statusColors[task.status] || 'outline'}>
            {TASK_STATUSES[task.status as keyof typeof TASK_STATUSES] || task.status}
          </Badge>
        </td>
        {/* 進捗&工数 */}
        <td className="px-1.5 py-1.5 md:px-3 md:py-2 whitespace-nowrap">
          <div className="flex items-center gap-1.5 md:gap-2">
            <div className="h-2 w-10 md:w-16 rounded-full bg-gray-200">
              <div className="h-2 rounded-full bg-blue-500" style={{ width: `${task.progressRate}%` }} />
            </div>
            <span>{task.progressRate}%</span>
            {effortText && <span className="text-xs text-gray-500">/ {effortText}</span>}
          </div>
        </td>
        {/* 予定期間 */}
        <td className="px-1.5 py-1.5 md:px-3 md:py-2 whitespace-nowrap">{plannedRangeText}</td>
        {/* 実績期間 */}
        <td className="px-1.5 py-1.5 md:px-3 md:py-2 whitespace-nowrap">{actualRangeText}</td>
        {/* 操作 */}
        <td className="px-1.5 py-1.5 md:px-3 md:py-2 whitespace-nowrap">
          <div className="flex gap-1">
            {canOpenEdit && (
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => onEditClick(task)}
                title="編集"
                aria-label="編集"
              >
                <Pencil className="h-4 w-4" />
              </Button>
            )}
            {canEditPmTl && (
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-red-600 hover:text-red-700"
                title="削除"
                aria-label="削除"
                onClick={async () => {
                  const label = isWP ? 'ワークパッケージ' : 'アクティビティ';
                  if (!confirm(`この${label}を削除しますか？`)) return;
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
  && prev.userId === next.userId
  && prev.projectId === next.projectId
  && prev.reload === next.reload
  && prev.onLoading === next.onLoading
  && prev.isSelected === next.isSelected
  && prev.selectedIds === next.selectedIds
  && prev.onToggleSelect === next.onToggleSelect
  && prev.members === next.members
  && prev.parentOptions === next.parentOptions
  && prev.onEditClick === next.onEditClick,
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
  const editingCanUpdateActual = canEditPmTl || (isEditingActivity && editingIsAssignee);
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
      let message = '更新に失敗しました';
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
  // ダイアログを新しく開き直したときは初期値（apply=全 false / values=既定）に戻すポリシー。
  // 以前のセッションの入力値が残っていると「他タスクでの選択が引き継がれてしまう」UX バグになるため。
  type BulkEditApply = {
    assigneeId: boolean;
    priority: boolean;
    plannedStartDate: boolean;
    plannedEndDate: boolean;
    plannedEffort: boolean;
  };
  type BulkEditValues = {
    assigneeId: string;
    priority: string;
    plannedStartDate: string;
    plannedEndDate: string;
    plannedEffort: number;
  };
  const bulkEditInitialApply = (): BulkEditApply => ({
    assigneeId: false,
    priority: false,
    plannedStartDate: false,
    plannedEndDate: false,
    plannedEffort: false,
  });
  const bulkEditInitialValues = (): BulkEditValues => ({
    assigneeId: '',
    priority: 'medium',
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
          <Dialog open={isBulkEditOpen} onOpenChange={handleBulkEditOpenChange}>
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
          <Dialog open={isBulkActualOpen} onOpenChange={handleBulkActualOpenChange}>
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
      <div className="rounded-lg border overflow-x-auto">
        <table className="min-w-full text-xs md:text-sm">
          <thead className="bg-gray-50">
            <tr>
              {canEditPmTl && (
                <th className="px-1.5 py-1.5 md:px-2 md:py-2 w-8">
                  <input
                    type="checkbox"
                    checked={isAllSelected}
                    onChange={toggleSelectAll}
                    className="rounded"
                    title="全選択"
                  />
                </th>
              )}
              <th className="px-1.5 py-1.5 md:px-3 md:py-2 text-left font-medium">名称</th>
              <th className="px-1.5 py-1.5 md:px-3 md:py-2 text-left font-medium whitespace-nowrap">担当者</th>
              <th className="px-1.5 py-1.5 md:px-3 md:py-2 text-left font-medium whitespace-nowrap">ステータス</th>
              <th className="px-1.5 py-1.5 md:px-3 md:py-2 text-left font-medium whitespace-nowrap">進捗&工数</th>
              <th className="px-1.5 py-1.5 md:px-3 md:py-2 text-left font-medium whitespace-nowrap">予定期間</th>
              <th className="px-1.5 py-1.5 md:px-3 md:py-2 text-left font-medium whitespace-nowrap">実績期間</th>
              <th className="px-1.5 py-1.5 md:px-3 md:py-2 text-left font-medium whitespace-nowrap">操作</th>
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
                onEditClick={openEditDialog}
              />
            ))}
            {tasks.length === 0 && (
              <tr>
                <td colSpan={canEditPmTl ? 8 : 7} className="py-8 text-center text-gray-500">
                  WBS が登録されていません
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* 編集ダイアログ: ロールに応じて PM/TL 編集項目・実績項目を出し分ける */}
      <Dialog open={editingTask != null} onOpenChange={(open) => { if (!open) closeEditDialog(); }}>
        <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editingTask?.type === 'work_package' ? 'ワークパッケージ編集' : 'アクティビティ編集'}
            </DialogTitle>
            <DialogDescription>
              {editingCanUpdatePm && editingCanUpdateActual
                ? '編集項目と実績項目を同時に更新できます。'
                : editingCanUpdatePm
                ? 'タスクの基本情報を編集します。'
                : '実績（ステータス・進捗率・実績日付）を更新します。'}
            </DialogDescription>
          </DialogHeader>
          {editingTask && editForm && (
            <form onSubmit={handleEditDialogSubmit} className="space-y-4">
              {editError && <div className="rounded-md bg-red-50 p-3 text-sm text-red-600">{editError}</div>}

              {/* PM/TL 編集セクション */}
              {editingCanUpdatePm && (
                <section className="space-y-3 rounded-md border border-gray-200 p-3">
                  <h4 className="text-sm font-medium text-gray-700">編集項目</h4>
                  <div className="space-y-2">
                    <Label>種別</Label>
                    <select
                      value={editForm.type}
                      onChange={(e) => setEditForm({ ...editForm, type: e.target.value as 'work_package' | 'activity' })}
                      className={nativeSelectClass}
                    >
                      {Object.entries(WBS_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                    </select>
                  </div>
                  <div className="space-y-2">
                    <Label>親WP</Label>
                    <select
                      value={editForm.parentTaskId}
                      onChange={(e) => setEditForm({ ...editForm, parentTaskId: e.target.value })}
                      className={nativeSelectClass}
                    >
                      <option value="">なし（最上位に配置）</option>
                      {parentOptions.filter((p) => p.id !== editingTask.id).map((p) => (
                        <option key={p.id} value={p.id}>{p.label}</option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-2">
                    <Label>名称</Label>
                    <Input value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} required />
                  </div>
                  {editForm.type === 'activity' && (
                    <>
                      <div className="space-y-2">
                        <Label>担当者</Label>
                        <select
                          value={editForm.assigneeId}
                          onChange={(e) => setEditForm({ ...editForm, assigneeId: e.target.value })}
                          className={nativeSelectClass}
                        >
                          <option value="">未設定</option>
                          {members.map((m) => (
                            <option key={m.userId} value={m.userId}>{m.userName}</option>
                          ))}
                        </select>
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-2">
                          <Label>予定開始日</Label>
                          <Input type="date" value={editForm.plannedStartDate} onChange={(e) => setEditForm({ ...editForm, plannedStartDate: e.target.value })} />
                        </div>
                        <div className="space-y-2">
                          <Label>予定終了日</Label>
                          <Input type="date" value={editForm.plannedEndDate} onChange={(e) => setEditForm({ ...editForm, plannedEndDate: e.target.value })} />
                        </div>
                      </div>
                      <div className="space-y-2">
                        <Label>見積工数（人時）</Label>
                        <NumberInput min={1} step={0.5} value={editForm.plannedEffort} onChange={(n) => setEditForm({ ...editForm, plannedEffort: n })} />
                      </div>
                    </>
                  )}
                </section>
              )}

              {/* 実績セクション（PM/TL または ACT の担当者本人のみ）*/}
              {editingCanUpdateActual && editForm.type === 'activity' && (
                <section className="space-y-3 rounded-md border border-gray-200 p-3">
                  <h4 className="text-sm font-medium text-gray-700">実績項目</h4>
                  <div className="space-y-2">
                    <Label>ステータス</Label>
                    <select
                      value={editForm.status}
                      onChange={(e) => {
                        const v = e.target.value;
                        const next = { ...editForm, status: v };
                        // 整合性ルール: 未着手→両クリア、完了以外→実績終了クリア
                        if (v === 'not_started') { next.actualStartDate = ''; next.actualEndDate = ''; }
                        else if (v !== 'completed') { next.actualEndDate = ''; }
                        setEditForm(next);
                      }}
                      className={nativeSelectClass}
                    >
                      {Object.entries(TASK_STATUSES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                    </select>
                  </div>
                  <div className="space-y-2">
                    <Label>進捗率</Label>
                    <NumberInput min={1} max={100} value={editForm.progressRate} onChange={(n) => setEditForm({ ...editForm, progressRate: n })} />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-2">
                      <Label className={editingActualStartDisabled ? 'text-gray-400' : ''}>実績開始日</Label>
                      <Input
                        type="date"
                        value={editForm.actualStartDate}
                        onChange={(e) => setEditForm({ ...editForm, actualStartDate: e.target.value })}
                        disabled={editingActualStartDisabled}
                        title={editingActualStartDisabled ? '未着手のタスクには実績開始日を入力できません' : undefined}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label className={editingActualEndDisabled ? 'text-gray-400' : ''}>実績終了日</Label>
                      <Input
                        type="date"
                        value={editForm.actualEndDate}
                        onChange={(e) => setEditForm({ ...editForm, actualEndDate: e.target.value })}
                        disabled={editingActualEndDisabled}
                        title={editingActualEndDisabled ? '完了状態のタスクのみ実績終了日を入力できます' : undefined}
                      />
                    </div>
                  </div>
                </section>
              )}

              <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" onClick={closeEditDialog}>キャンセル</Button>
                <Button type="submit">保存</Button>
              </div>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
