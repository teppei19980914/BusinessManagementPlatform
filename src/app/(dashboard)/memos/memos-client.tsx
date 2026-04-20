'use client';

/**
 * 全メモ画面クライアント (PR #70)。
 *
 * - 自分のメモ (private/public すべて) + 他人の public メモを表示
 * - 作成/編集ダイアログで CRUD、他人のメモは参照のみ
 * - URL 添付 (AttachmentList, entityType='memo') を編集ダイアログに組み込み
 * - 列幅リサイズ (PR #68) + 添付列 (PR #67) のパターンを踏襲
 */

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useLoading } from '@/components/loading-overlay';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
import {
  Table, TableBody, TableCell, TableHeader, TableRow,
} from '@/components/ui/table';
import { nativeSelectClass } from '@/components/ui/native-select-style';
import {
  ResizableColumnsProvider,
  ResizableHead,
  ResetColumnsButton,
} from '@/components/ui/resizable-columns';
import { AttachmentList } from '@/components/attachments/attachment-list';
import {
  StagedAttachmentsInput,
  persistStagedAttachments,
  type StagedAttachment,
} from '@/components/attachments/staged-attachments-input';
import { useBatchAttachments } from '@/components/attachments/use-batch-attachments';
import { AttachmentsCell } from '@/components/attachments/attachments-cell';
import { formatDateTime } from '@/lib/format';
import type { MemoDTO } from '@/services/memo.service';

const VISIBILITY_LABELS: Record<string, string> = {
  private: '自分のみ',
  public: '全メモに公開',
};

export function MemosClient({
  memos: initialMemos,
  viewerUserId,
}: {
  memos: MemoDTO[];
  viewerUserId: string;
}) {
  const router = useRouter();
  const { withLoading } = useLoading();
  const [memos, setMemos] = useState(initialMemos);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [editing, setEditing] = useState<MemoDTO | null>(null);
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    const res = await fetch('/api/memos');
    if (res.ok) {
      const json = await res.json();
      setMemos((json.data as MemoDTO[]) ?? []);
    }
    router.refresh();
  }, [router]);

  // 添付列用バッチ取得 (PR #67 パターン)
  const attachmentsByEntity = useBatchAttachments('memo', memos.map((m) => m.id));

  // --- 作成ダイアログ ---
  const [createForm, setCreateForm] = useState({
    title: '',
    content: '',
    visibility: 'private',
  });
  const [stagedCreateAttachments, setStagedCreateAttachments] = useState<StagedAttachment[]>([]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    const res = await withLoading(() =>
      fetch('/api/memos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createForm),
      }),
    );
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      setError(json.error?.message || json.error?.details?.[0]?.message || '作成に失敗しました');
      return;
    }
    const json = await res.json();
    // 作成成功後、ステージ添付を一括 POST (PR #67 パターン)
    if (stagedCreateAttachments.length > 0 && json.data?.id) {
      await persistStagedAttachments({
        entityType: 'memo',
        entityId: json.data.id,
        items: stagedCreateAttachments,
      });
    }
    setStagedCreateAttachments([]);
    setCreateForm({ title: '', content: '', visibility: 'private' });
    setIsCreateOpen(false);
    await reload();
  }

  // --- 編集ダイアログ ---
  // Derived State パターン (useEffect 不要): editing が切り替わったら form を同期
  type EditFormState = { title: string; content: string; visibility: string };
  const [editForm, setEditForm] = useState<EditFormState>({
    title: '',
    content: '',
    visibility: 'private',
  });
  const [prevEditingId, setPrevEditingId] = useState<string | null>(null);
  if (editing && editing.id !== prevEditingId) {
    setPrevEditingId(editing.id);
    setEditForm({
      title: editing.title,
      content: editing.content,
      visibility: editing.visibility,
    });
    setError('');
  }

  async function handleEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editing) return;
    setError('');
    const res = await withLoading(() =>
      fetch(`/api/memos/${editing.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editForm),
      }),
    );
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      setError(json.error?.message || '更新に失敗しました');
      return;
    }
    setEditing(null);
    await reload();
  }

  async function handleDelete(memo: MemoDTO) {
    if (!confirm(`「${memo.title}」を削除しますか？`)) return;
    const res = await withLoading(() =>
      fetch(`/api/memos/${memo.id}`, { method: 'DELETE' }),
    );
    if (!res.ok) {
      alert('削除に失敗しました');
      return;
    }
    await reload();
  }

  // initialMemos の更新に合わせて state 側も追従 (Derived State)
  useEffect(() => {
    setMemos(initialMemos);
  }, [initialMemos]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">全メモ</h2>
        <div className="flex items-center gap-2">
          <span className="text-sm text-gray-500">{memos.length} 件</span>
          <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
            <DialogTrigger className="inline-flex shrink-0 items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-xs hover:bg-primary/90">
              メモ作成
            </DialogTrigger>
            <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>メモ作成</DialogTitle>
                <DialogDescription>
                  既定は「自分のみ」(非公開)。「全メモに公開」を選ぶと他アカウントも閲覧可能になります。
                </DialogDescription>
              </DialogHeader>
              <form onSubmit={handleCreate} className="space-y-4">
                {error && <div className="rounded-md bg-red-50 p-3 text-sm text-red-600">{error}</div>}
                <div className="space-y-2">
                  <Label>公開範囲</Label>
                  <select
                    value={createForm.visibility}
                    onChange={(e) => setCreateForm({ ...createForm, visibility: e.target.value })}
                    className={nativeSelectClass}
                  >
                    {Object.entries(VISIBILITY_LABELS).map(([k, l]) => (
                      <option key={k} value={k}>{l}</option>
                    ))}
                  </select>
                </div>
                <div className="space-y-2">
                  <Label>タイトル</Label>
                  <Input
                    value={createForm.title}
                    onChange={(e) => setCreateForm({ ...createForm, title: e.target.value })}
                    maxLength={150}
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label>本文</Label>
                  <textarea
                    className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                    value={createForm.content}
                    onChange={(e) => setCreateForm({ ...createForm, content: e.target.value })}
                    rows={8}
                    maxLength={10000}
                    required
                  />
                </div>
                <StagedAttachmentsInput
                  value={stagedCreateAttachments}
                  onChange={setStagedCreateAttachments}
                  label="参考 URL"
                />
                <Button type="submit" className="w-full">作成</Button>
              </form>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      <ResizableColumnsProvider tableKey="all-memos">
        <div className="flex justify-end pb-2">
          <ResetColumnsButton />
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <ResizableHead columnKey="title" defaultWidth={220}>タイトル</ResizableHead>
              <ResizableHead columnKey="content" defaultWidth={300}>本文</ResizableHead>
              <ResizableHead columnKey="visibility" defaultWidth={110}>公開範囲</ResizableHead>
              <ResizableHead columnKey="author" defaultWidth={120}>作成者</ResizableHead>
              <ResizableHead columnKey="updatedAt" defaultWidth={140}>更新日時</ResizableHead>
              <ResizableHead columnKey="attachments" defaultWidth={200}>添付</ResizableHead>
              <ResizableHead columnKey="actions" defaultWidth={120}>操作</ResizableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {memos.map((m) => (
              <TableRow
                key={m.id}
                className={m.isMine ? 'cursor-pointer hover:bg-gray-50' : ''}
                onClick={m.isMine ? () => setEditing(m) : undefined}
              >
                <TableCell className="font-medium">{m.title}</TableCell>
                <TableCell className="max-w-md truncate text-sm text-gray-700" title={m.content}>
                  {m.content.slice(0, 80)}
                </TableCell>
                <TableCell>
                  <Badge variant={m.visibility === 'public' ? 'default' : 'outline'}>
                    {VISIBILITY_LABELS[m.visibility] ?? m.visibility}
                  </Badge>
                </TableCell>
                <TableCell className="text-sm text-gray-600">
                  {m.authorName ?? '-'}{m.isMine && <span className="ml-1 text-xs text-blue-600">(自分)</span>}
                </TableCell>
                <TableCell className="whitespace-nowrap text-sm text-gray-600">{formatDateTime(m.updatedAt)}</TableCell>
                <TableCell onClick={(e) => e.stopPropagation()}>
                  <AttachmentsCell items={attachmentsByEntity[m.id] ?? []} />
                </TableCell>
                <TableCell onClick={(e) => e.stopPropagation()}>
                  {m.isMine && (
                    <div className="flex gap-1">
                      <Button variant="outline" size="sm" onClick={() => setEditing(m)}>編集</Button>
                      <Button variant="outline" size="sm" className="text-red-600" onClick={() => handleDelete(m)}>削除</Button>
                    </div>
                  )}
                </TableCell>
              </TableRow>
            ))}
            {memos.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="py-8 text-center text-gray-500">
                  メモがありません。右上の「メモ作成」から登録してください。
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </ResizableColumnsProvider>

      {/* 編集ダイアログ (自分のメモのみ開く) */}
      <Dialog open={editing != null} onOpenChange={(o) => { if (!o) setEditing(null); }}>
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>メモ編集</DialogTitle>
            <DialogDescription>変更内容を保存します。</DialogDescription>
          </DialogHeader>
          {editing && (
            <form onSubmit={handleEdit} className="space-y-4">
              {error && <div className="rounded-md bg-red-50 p-3 text-sm text-red-600">{error}</div>}
              <div className="space-y-2">
                <Label>公開範囲</Label>
                <select
                  value={editForm.visibility}
                  onChange={(e) => setEditForm({ ...editForm, visibility: e.target.value })}
                  className={nativeSelectClass}
                >
                  {Object.entries(VISIBILITY_LABELS).map(([k, l]) => (
                    <option key={k} value={k}>{l}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-2">
                <Label>タイトル</Label>
                <Input
                  value={editForm.title}
                  onChange={(e) => setEditForm({ ...editForm, title: e.target.value })}
                  maxLength={150}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label>本文</Label>
                <textarea
                  className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  value={editForm.content}
                  onChange={(e) => setEditForm({ ...editForm, content: e.target.value })}
                  rows={8}
                  maxLength={10000}
                  required
                />
              </div>
              {/* URL 添付 (編集時は既存の AttachmentList で追加/削除可能) */}
              <AttachmentList
                entityType="memo"
                entityId={editing.id}
                canEdit={editing.userId === viewerUserId}
                label="参考 URL"
              />
              <Button type="submit" className="w-full">保存</Button>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
