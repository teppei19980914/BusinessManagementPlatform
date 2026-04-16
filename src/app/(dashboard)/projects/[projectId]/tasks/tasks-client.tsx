'use client';

import { useState, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useLoading } from '@/components/loading-overlay';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
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
import { TASK_STATUSES, PRIORITIES, WBS_TYPES } from '@/types';
import type { TaskDTO } from '@/services/task.service';
import type { MemberDTO } from '@/services/member.service';

type ProjectSummary = { id: string; name: string };

type Props = {
  projectId: string;
  tasks: TaskDTO[];
  members: MemberDTO[];
  allProjects: ProjectSummary[];
  projectRole: string | null;
  systemRole: string;
  userId: string;
};

const statusColors: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  not_started: 'outline',
  in_progress: 'default',
  completed: 'secondary',
  on_hold: 'destructive',
};

/** ツリーから全IDを再帰的に収集する */
function collectAllIds(nodes: TaskDTO[]): string[] {
  const ids: string[] = [];
  for (const node of nodes) {
    ids.push(node.id);
    if (node.children) {
      ids.push(...collectAllIds(node.children));
    }
  }
  return ids;
}

function TaskTreeNode({
  task,
  depth,
  canEditPmTl,
  userId,
  projectId,
  router,
  onLoading,
  selectedIds,
  onToggleSelect,
  members,
  parentOptions,
}: {
  task: TaskDTO;
  depth: number;
  canEditPmTl: boolean;
  userId: string;
  projectId: string;
  router: ReturnType<typeof useRouter>;
  onLoading: <T>(fn: () => Promise<T>) => Promise<T>;
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  members: MemberDTO[];
  parentOptions: { id: string; label: string }[];
}) {
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

  const isWP = task.type === 'work_package';
  const isAssignee = task.assigneeId === userId;
  // メンバー編集: 担当者のみ（ACT限定）
  const canMemberEdit = !isWP && isAssignee;

  async function handlePmEditSubmit(e: React.FormEvent) {
    e.preventDefault();
    const body: Record<string, unknown> = {
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
    router.refresh();
  }

  async function handleMemberEditSubmit(e: React.FormEvent) {
    e.preventDefault();
    await onLoading(() =>
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
    setShowMemberEdit(false);
    router.refresh();
  }

  const colSpan = canEditPmTl ? 11 : 10;

  return (
    <>
      <tr className={`border-b hover:bg-gray-50 ${isWP ? 'bg-gray-50/50' : ''}`}>
        {canEditPmTl && (
          <td className="px-2 py-2 w-8">
            <input type="checkbox" checked={selectedIds.has(task.id)} onChange={() => onToggleSelect(task.id)} className="rounded" />
          </td>
        )}
        <td className="px-3 py-2" style={{ paddingLeft: `${depth * 24 + 12}px` }}>
          <div className="flex items-center gap-2">
            <Badge variant={isWP ? 'default' : 'outline'} className="text-[10px] px-1.5 py-0">
              {isWP ? 'WP' : 'ACT'}
            </Badge>
            <span className={`${isWP ? 'font-semibold' : 'font-medium'}`}>{task.name}</span>
            {task.wbsNumber && (
              <span className="text-xs text-gray-400">{task.wbsNumber}</span>
            )}
          </div>
        </td>
        <td className="px-3 py-2 text-sm">{isWP ? '-' : (task.assigneeName || '-')}</td>
        <td className="px-3 py-2">
          <Badge variant={statusColors[task.status] || 'outline'}>
            {TASK_STATUSES[task.status as keyof typeof TASK_STATUSES] || task.status}
          </Badge>
        </td>
        <td className="px-3 py-2 text-sm">
          <div className="flex items-center gap-2">
            <div className="h-2 w-16 rounded-full bg-gray-200">
              <div
                className="h-2 rounded-full bg-blue-500"
                style={{ width: `${task.progressRate}%` }}
              />
            </div>
            <span>{task.progressRate}%</span>
          </div>
        </td>
        <td className="px-3 py-2 text-sm">{task.plannedEffort > 0 ? task.plannedEffort : '-'}</td>
        <td className="px-3 py-2 text-sm">{task.plannedStartDate || '-'}</td>
        <td className="px-3 py-2 text-sm">{task.plannedEndDate || '-'}</td>
        <td className="px-3 py-2 text-sm">{task.actualStartDate || '-'}</td>
        <td className="px-3 py-2 text-sm">{task.actualEndDate || '-'}</td>
        <td className="px-3 py-2">
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
                  router.refresh();
                }}
              >
                削除
              </Button>
            )}
          </div>
        </td>
      </tr>
      {/* メンバー編集フォーム: ステータス・進捗率・実績開始日・実績終了日 */}
      {showMemberEdit && canMemberEdit && (
        <tr className="border-b bg-blue-50">
          <td colSpan={colSpan} className="px-6 py-3">
            <form onSubmit={handleMemberEditSubmit} className="flex items-end gap-4">
              <div className="space-y-1">
                <Label className="text-xs">ステータス</Label>
                <LabeledSelect value={memberEditForm.status} onValueChange={(v) => v && setMemberEditForm({ ...memberEditForm, status: v })} options={TASK_STATUSES} className="w-28" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">進捗率</Label>
                <Input type="number" min={0} max={100} value={memberEditForm.progressRate} onChange={(e) => setMemberEditForm({ ...memberEditForm, progressRate: Number(e.target.value) })} className="w-20" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">開始日（実績）</Label>
                <Input type="date" value={memberEditForm.actualStartDate} onChange={(e) => setMemberEditForm({ ...memberEditForm, actualStartDate: e.target.value })} className="w-36" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">終了日（実績）</Label>
                <Input type="date" value={memberEditForm.actualEndDate} onChange={(e) => setMemberEditForm({ ...memberEditForm, actualEndDate: e.target.value })} className="w-36" />
              </div>
              <Button type="submit" size="sm">更新</Button>
              <Button type="button" variant="outline" size="sm" onClick={() => setShowMemberEdit(false)}>閉じる</Button>
            </form>
          </td>
        </tr>
      )}
      {/* PM/TL 編集フォーム */}
      {showPmEdit && (
        <tr className="border-b bg-green-50">
          <td colSpan={colSpan} className="px-6 py-3">
            <form onSubmit={handlePmEditSubmit} className="space-y-3">
              <div className="flex flex-wrap items-end gap-4">
                <div className="space-y-1">
                  <Label className="text-xs">種別</Label>
                  <span className="block text-sm font-medium px-1">{isWP ? 'ワークパッケージ' : 'アクティビティ'}</span>
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
              {!isWP && (
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
                    <Input type="number" min={0} step={0.5} value={pmEditForm.plannedEffort} onChange={(e) => setPmEditForm({ ...pmEditForm, plannedEffort: Number(e.target.value) })} className="w-24" />
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
      {task.children?.map((child) => (
        <TaskTreeNode
          key={child.id}
          task={child}
          depth={depth + 1}
          canEditPmTl={canEditPmTl}
          userId={userId}
          projectId={projectId}
          router={router}
          onLoading={onLoading}
          selectedIds={selectedIds}
          onToggleSelect={onToggleSelect}
          members={members}
          parentOptions={parentOptions}
        />
      ))}
    </>
  );
}

export function TasksClient({ projectId, tasks, members, allProjects, projectRole, systemRole, userId }: Props) {
  const router = useRouter();
  const { withLoading } = useLoading();
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [isCopyOpen, setIsCopyOpen] = useState(false);
  const [copySource, setCopySource] = useState('');
  const [copyError, setCopyError] = useState('');
  const [error, setError] = useState('');

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

  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  const [bulkAssigneeId, setBulkAssigneeId] = useState('');
  const [bulkPriority, setBulkPriority] = useState('');

  async function handleBulkDelete() {
    if (selectedIds.size === 0) return;
    if (!confirm(`${selectedIds.size} 件を一括削除しますか？`)) return;
    for (const id of selectedIds) {
      await withLoading(() =>
        fetch(`/api/projects/${projectId}/tasks/${id}`, { method: 'DELETE' }),
      );
    }
    setSelectedIds(new Set());
    router.refresh();
  }

  async function handleBulkUpdate() {
    if (selectedIds.size === 0) return;
    const body: Record<string, unknown> = { taskIds: [...selectedIds] };
    if (bulkAssigneeId) body.assigneeId = bulkAssigneeId;
    if (bulkPriority) body.priority = bulkPriority;
    if (!bulkAssigneeId && !bulkPriority) return;

    const res = await withLoading(() =>
      fetch(`/api/projects/${projectId}/tasks/bulk-update`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );

    if (!res.ok) return;

    setSelectedIds(new Set());
    setBulkAssigneeId('');
    setBulkPriority('');
    router.refresh();
  }

  // コピー元候補（自分自身を含む全プロジェクト）
  const copySourceProjects = useMemo(
    () => allProjects,
    [allProjects],
  );

  async function handleCopyWbs(e: React.FormEvent) {
    e.preventDefault();
    setCopyError('');
    if (!copySource) { setCopyError('コピー元プロジェクトを選択してください'); return; }

    const res = await withLoading(() =>
      fetch(`/api/projects/${projectId}/tasks/copy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceProjectId: copySource }),
      }),
    );

    if (!res.ok) {
      const json = await res.json();
      setCopyError(json.error?.message || 'コピーに失敗しました');
      return;
    }

    setIsCopyOpen(false);
    setCopySource('');
    router.refresh();
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

    const csvText = await importFile.text();

    const res = await withLoading(() =>
      fetch(`/api/projects/${projectId}/tasks/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/csv; charset=utf-8' },
        body: csvText,
      }),
    );

    if (!res.ok) {
      const json = await res.json();
      setImportError(json.error?.message || json.error?.details?.[0]?.message || 'インポートに失敗しました');
      return;
    }

    setIsImportOpen(false);
    setImportFile(null);
    router.refresh();
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
    plannedEffort: '' as string | number,
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
          plannedEffort: Number(form.plannedEffort),
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
    setForm({ name: '', assigneeId: '', plannedStartDate: '', plannedEndDate: '', plannedEffort: '', priority: 'medium' });
    router.refresh();
  }

  // Dialog 内のセレクト用スタイル（native select — base-ui Select は Dialog Portal と干渉するため）
  const nativeSelectClass = 'flex h-8 w-full items-center rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50';

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">WBS管理</h2>
        {canEditPmTl && (
          <div className="flex gap-2">
          <Dialog open={isCopyOpen} onOpenChange={setIsCopyOpen}>
            <DialogTrigger className="inline-flex shrink-0 items-center justify-center rounded-md border border-input bg-background px-3 py-1.5 text-sm hover:bg-accent">WBSコピー</DialogTrigger>
            <DialogContent className="max-w-md">
              <DialogHeader>
                <DialogTitle>WBS コピー</DialogTitle>
                <DialogDescription>既存プロジェクトの WBS を一括コピーします。担当者はリセットされ、進捗は初期状態になります。</DialogDescription>
              </DialogHeader>
              <form onSubmit={handleCopyWbs} className="space-y-4">
                {copyError && <div className="rounded-md bg-red-50 p-3 text-sm text-red-600">{copyError}</div>}
                <div className="space-y-2">
                  <Label>コピー元プロジェクト</Label>
                  <select
                    value={copySource}
                    onChange={(e) => setCopySource(e.target.value)}
                    className={nativeSelectClass}
                  >
                    <option value="">プロジェクトを選択...</option>
                    {copySourceProjects.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                </div>
                <Button type="submit" className="w-full">コピー実行</Button>
              </form>
            </DialogContent>
          </Dialog>
          <Button variant="outline" size="sm" onClick={handleExport}>
            {selectedIds.size > 0 ? `エクスポート(${selectedIds.size}件)` : 'エクスポート'}
          </Button>
          <Dialog open={isImportOpen} onOpenChange={setIsImportOpen}>
            <DialogTrigger className="inline-flex shrink-0 items-center justify-center rounded-md border border-input bg-background px-3 py-1.5 text-sm hover:bg-accent">インポート</DialogTrigger>
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
            <DialogTrigger className="inline-flex shrink-0 items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-xs hover:bg-primary/90">追加</DialogTrigger>
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
                        <Input type="number" min={0} step={0.5} value={form.plannedEffort} onChange={(e) => setForm({ ...form, plannedEffort: e.target.value })} required />
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
          <div className="flex items-center gap-2">
            <LabeledSelect
              value={bulkAssigneeId}
              onValueChange={(v) => setBulkAssigneeId(v ?? '')}
              options={Object.fromEntries(members.map((m) => [m.userId, m.userName]))}
              placeholder="担当者..."
            />
            <LabeledSelect
              value={bulkPriority}
              onValueChange={(v) => setBulkPriority(v ?? '')}
              options={PRIORITIES}
              placeholder="優先度..."
            />
            <Button variant="outline" size="sm" onClick={handleBulkUpdate} disabled={!bulkAssigneeId && !bulkPriority}>一括変更</Button>
          </div>
          <Button variant="outline" size="sm" className="text-red-600" onClick={handleBulkDelete}>一括削除</Button>
          <Button variant="outline" size="sm" onClick={() => { setSelectedIds(new Set()); setBulkAssigneeId(''); setBulkPriority(''); }}>選択解除</Button>
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
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
              <th className="px-3 py-2 text-left font-medium">担当者</th>
              <th className="px-3 py-2 text-left font-medium">ステータス</th>
              <th className="px-3 py-2 text-left font-medium">進捗</th>
              <th className="px-3 py-2 text-left font-medium">工数</th>
              <th className="px-3 py-2 text-left font-medium">予定開始</th>
              <th className="px-3 py-2 text-left font-medium">予定終了</th>
              <th className="px-3 py-2 text-left font-medium">実績開始</th>
              <th className="px-3 py-2 text-left font-medium">実績終了</th>
              <th className="px-3 py-2 text-left font-medium">操作</th>
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
                router={router}
                onLoading={withLoading}
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
