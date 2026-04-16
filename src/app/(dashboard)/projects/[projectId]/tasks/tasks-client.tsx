'use client';

import { useState } from 'react';
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

function TaskTreeNode({
  task,
  depth,
  canEdit,
  userId,
  projectId,
  router,
  onLoading,
}: {
  task: TaskDTO;
  depth: number;
  canEdit: boolean;
  userId: string;
  projectId: string;
  router: ReturnType<typeof useRouter>;
  onLoading: <T>(fn: () => Promise<T>) => Promise<T>;
}) {
  const [showProgress, setShowProgress] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
  const [editForm, setEditForm] = useState({
    name: task.name,
    plannedStartDate: task.plannedStartDate,
    plannedEndDate: task.plannedEndDate,
    plannedEffort: task.plannedEffort,
  });
  const [progressForm, setProgressForm] = useState({
    progressRate: task.progressRate,
    actualEffort: 0,
    status: task.status,
  });

  const isWP = task.type === 'work_package';
  const isAssignee = task.assigneeId === userId;
  // 進捗更新: 担当者のみ（ACT限定）
  const canShowProgress = !isWP && isAssignee;
  // 編集: PM/TL・admin のみ
  // canEdit は親コンポーネントから渡される（systemRole === 'admin' || projectRole === 'pm_tl'）

  async function handleEditSubmit(e: React.FormEvent) {
    e.preventDefault();
    await onLoading(() =>
      fetch(`/api/projects/${projectId}/tasks/${task.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editForm),
      }),
    );
    setShowEdit(false);
    router.refresh();
  }

  async function handleProgressSubmit(e: React.FormEvent) {
    e.preventDefault();
    await onLoading(() =>
      fetch(`/api/projects/${projectId}/tasks/${task.id}/progress`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(progressForm),
      }),
    );
    setShowProgress(false);
    router.refresh();
  }

  return (
    <>
      <tr className={`border-b hover:bg-gray-50 ${isWP ? 'bg-gray-50/50' : ''}`}>
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
        <td className="px-3 py-2">
          <div className="flex gap-1">
            {canShowProgress && (
              <Button variant="outline" size="sm" onClick={() => setShowProgress(!showProgress)}>
                進捗
              </Button>
            )}
            {canEdit && (
              <Button variant="outline" size="sm" onClick={() => setShowEdit(!showEdit)}>編集</Button>
            )}
            {canEdit && (
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
      {showProgress && canShowProgress && (
        <tr className="border-b bg-blue-50">
          <td colSpan={8} className="px-6 py-3">
            <form onSubmit={handleProgressSubmit} className="flex items-end gap-4">
              <div className="space-y-1">
                <Label className="text-xs">進捗率</Label>
                <Input type="number" min={0} max={100} value={progressForm.progressRate} onChange={(e) => setProgressForm({ ...progressForm, progressRate: Number(e.target.value) })} className="w-20" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">実績工数</Label>
                <Input type="number" min={0} step={0.5} value={progressForm.actualEffort} onChange={(e) => setProgressForm({ ...progressForm, actualEffort: Number(e.target.value) })} className="w-20" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">ステータス</Label>
                <LabeledSelect value={progressForm.status} onValueChange={(v) => v && setProgressForm({ ...progressForm, status: v })} options={TASK_STATUSES} className="w-28" />
              </div>
              <Button type="submit" size="sm">更新</Button>
              <Button type="button" variant="outline" size="sm" onClick={() => setShowProgress(false)}>閉じる</Button>
            </form>
          </td>
        </tr>
      )}
      {showEdit && (
        <tr className="border-b bg-green-50">
          <td colSpan={8} className="px-6 py-3">
            <form onSubmit={handleEditSubmit} className="flex items-end gap-4">
              <div className="space-y-1">
                <Label className="text-xs">名前</Label>
                <Input value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} className="w-48" required />
              </div>
              {!isWP && (
                <>
                  <div className="space-y-1">
                    <Label className="text-xs">開始日</Label>
                    <Input type="date" value={editForm.plannedStartDate ?? ''} onChange={(e) => setEditForm({ ...editForm, plannedStartDate: e.target.value })} className="w-36" />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">終了日</Label>
                    <Input type="date" value={editForm.plannedEndDate ?? ''} onChange={(e) => setEditForm({ ...editForm, plannedEndDate: e.target.value })} className="w-36" />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">見積工数</Label>
                    <Input type="number" min={0} step={0.5} value={editForm.plannedEffort} onChange={(e) => setEditForm({ ...editForm, plannedEffort: Number(e.target.value) })} className="w-24" />
                  </div>
                </>
              )}
              <Button type="submit" size="sm">保存</Button>
              <Button type="button" variant="outline" size="sm" onClick={() => setShowEdit(false)}>閉じる</Button>
            </form>
          </td>
        </tr>
      )}
      {task.children?.map((child) => (
        <TaskTreeNode
          key={child.id}
          task={child}
          depth={depth + 1}
          canEdit={canEdit}

          userId={userId}
          projectId={projectId}
          router={router}
          onLoading={onLoading}
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

  const canEdit = systemRole === 'admin' || projectRole === 'pm_tl';

  // コピー元候補（自分自身を除外）
  const copySourceOptions = Object.fromEntries(
    allProjects.filter((p) => p.id !== projectId).map((p) => [p.id, p.name]),
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

  const [createType, setCreateType] = useState<'work_package' | 'activity'>('activity');
  const [parentTaskId, setParentTaskId] = useState('');

  // 親候補: WP のフラット一覧（ツリーを再帰的に展開）
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
  const parentOptions = flattenWPs(tasks);

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

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">WBS管理</h2>
        {canEdit && (
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
                  <LabeledSelect value={copySource} onValueChange={(v) => setCopySource(v ?? '')} options={copySourceOptions} placeholder="プロジェクトを選択..." />
                </div>
                <Button type="submit" className="w-full">コピー実行</Button>
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
                  <LabeledSelect
                    value={createType}
                    onValueChange={(v) => v && setCreateType(v as 'work_package' | 'activity')}
                    options={WBS_TYPES}
                  />
                </div>
                <div className="space-y-2">
                  <Label>親ワークパッケージ</Label>
                  <LabeledSelect
                    value={parentTaskId}
                    onValueChange={(v) => setParentTaskId(v ?? '')}
                    options={Object.fromEntries(parentOptions.map((p) => [p.id, p.label]))}
                    placeholder="なし（最上位に配置）"
                  />
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
                        <LabeledSelect
                          value={form.assigneeId}
                          onValueChange={(v) => v && setForm({ ...form, assigneeId: v })}
                          options={Object.fromEntries(members.map((m) => [m.userId, m.userName]))}
                          placeholder="選択..."
                        />
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
                        <LabeledSelect value={form.priority} onValueChange={(v) => v && setForm({ ...form, priority: v })} options={PRIORITIES} />
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

      <div className="rounded-lg border">
        <table className="w-full text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-3 py-2 text-left font-medium">名称</th>
              <th className="px-3 py-2 text-left font-medium">担当者</th>
              <th className="px-3 py-2 text-left font-medium">ステータス</th>
              <th className="px-3 py-2 text-left font-medium">進捗</th>
              <th className="px-3 py-2 text-left font-medium">工数</th>
              <th className="px-3 py-2 text-left font-medium">開始</th>
              <th className="px-3 py-2 text-left font-medium">終了</th>
              <th className="px-3 py-2 text-left font-medium">操作</th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((task) => (
              <TaskTreeNode
                key={task.id}
                task={task}
                depth={0}
                canEdit={canEdit}

                userId={userId}
                projectId={projectId}
                router={router}
                onLoading={withLoading}
              />
            ))}
            {tasks.length === 0 && (
              <tr>
                <td colSpan={8} className="py-8 text-center text-gray-500">
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
