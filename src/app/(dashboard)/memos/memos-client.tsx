'use client';

/**
 * 全メモ画面クライアント (PR #70)。
 *
 * - 自分のメモ (private/public すべて) + 他人の public メモを表示
 * - 作成/編集ダイアログで CRUD、他人のメモは参照のみ
 * - URL 添付 (AttachmentList, entityType='memo') を編集ダイアログに組み込み
 * - 列幅リサイズ (PR #68) + 添付列 (PR #67) のパターンを踏襲
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
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
// PR #119: session 連携フォーマッタ
import { useFormatters } from '@/lib/use-formatters';
// feat/dialog-fullscreen-toggle: 文字量が多い dialog 向けの全画面トグル
import { useDialogFullscreen } from '@/components/ui/use-dialog-fullscreen';
// feat/markdown-textarea: Markdown 入力 + プレビュー + 既存値との差分表示
import { MarkdownTextarea } from '@/components/ui/markdown-textarea';
import type { MemoDTO } from '@/services/memo.service';
// PR #165: 個人「メモ一覧」での一括 visibility 変更機能 (cross-list /all-memos から移し替え)
import {
  CrossListBulkVisibilityToolbar,
  EMPTY_FILTER,
  isCrossListFilterActive,
  type CrossListFilterState,
} from '@/components/cross-list-bulk-visibility-toolbar';

const MEMO_VISIBILITY_OPTIONS = [
  { value: 'private', label: '自分のみ (公開取り下げ)' },
  { value: 'public', label: '全メモに公開' },
];

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
  const t = useTranslations('action');
  const router = useRouter();
  const { withLoading } = useLoading();
  // PR #119: session 連携フォーマッタ
  const { formatDateTime } = useFormatters();
  const [memos, setMemos] = useState(initialMemos);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [editing, setEditing] = useState<MemoDTO | null>(null);
  const [error, setError] = useState('');
  // feat/dialog-fullscreen-toggle: 全画面トグル (90vw × 90vh)。create / edit で別 state を持たせる。
  const { fullscreenClassName: createFsClassName, FullscreenToggle: CreateFullscreenToggle } = useDialogFullscreen();
  const { fullscreenClassName: editFsClassName, FullscreenToggle: EditFullscreenToggle } = useDialogFullscreen();

  const reload = useCallback(async () => {
    const res = await fetch('/api/memos');
    if (res.ok) {
      const json = await res.json();
      setMemos((json.data as MemoDTO[]) ?? []);
    }
    router.refresh();
  }, [router]);

  // PR #165: 個人「メモ一覧」での一括 visibility 変更
  // フィルター適用時のみ checkbox 列とツールバー表示。Memo は元から isMine=true のものだけ
  // 編集できるため、checkbox は isMine=true 行のみ active。
  const [bulkFilter, setBulkFilter] = useState<CrossListFilterState>(EMPTY_FILTER);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const filterApplied = isCrossListFilterActive(bulkFilter);

  const filteredMemos = useMemo(() => {
    let xs = memos;
    if (bulkFilter.mineOnly) xs = xs.filter((m) => m.isMine);
    if (bulkFilter.keyword.trim()) {
      const kw = bulkFilter.keyword.trim().toLowerCase();
      xs = xs.filter((m) => m.title.toLowerCase().includes(kw) || m.content.toLowerCase().includes(kw));
    }
    return xs;
  }, [memos, bulkFilter]);

  const selectableIds = filterApplied
    ? filteredMemos.filter((m) => m.isMine).map((m) => m.id)
    : [];
  const allSelectableSelected
    = selectableIds.length > 0 && selectableIds.every((id) => selectedIds.has(id));

  function toggleOneMemo(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleAllMemos() {
    setSelectedIds(allSelectableSelected ? new Set() : new Set(selectableIds));
  }

  // 添付列用バッチ取得 (PR #67 パターン)
  const attachmentsByEntity = useBatchAttachments('memo', filteredMemos.map((m) => m.id));

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
  // PR #88: 編集ダイアログを開くたびに DB 上のデータ (editing prop) を初期表示する。
  // 閉じた時に prevEditingId を null にリセットすることで、同一メモを再度開いた場合も
  // 編集途中の状態ではなく DB の最新データが表示される (ユーザ期待どおり)。
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
  if (!editing && prevEditingId !== null) {
    setPrevEditingId(null);
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
      {/* PR #165: 個人「メモ一覧」での一括 visibility 変更 */}
      <CrossListBulkVisibilityToolbar
        endpoint="/api/memos/bulk"
        formIdPrefix="memos-personal"
        filter={bulkFilter}
        onFilterChange={setBulkFilter}
        selectedIds={selectedIds}
        onSelectionClear={() => setSelectedIds(new Set())}
        visibilityOptions={MEMO_VISIBILITY_OPTIONS}
        entityLabel="メモ"
        onApplied={async () => { await reload(); }}
      />

      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">メモ一覧</h2>
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">{filteredMemos.length} 件</span>
          <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
            <DialogTrigger className="inline-flex shrink-0 items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-xs hover:bg-primary/90">
              メモ作成
            </DialogTrigger>
            <DialogContent className={`max-w-[min(90vw,36rem)] max-h-[85vh] overflow-y-auto ${createFsClassName}`}>
              <DialogHeader>
                <div className="flex items-center justify-between gap-2">
                  <DialogTitle>メモ作成</DialogTitle>
                  <CreateFullscreenToggle />
                </div>
                <DialogDescription>
                  既定は「自分のみ」(非公開)。「全メモに公開」を選ぶと他アカウントも閲覧可能になります。
                </DialogDescription>
              </DialogHeader>
              <form onSubmit={handleCreate} className="space-y-4">
                {error && <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}
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
                  <Label>本文 <span className="text-xs text-muted-foreground">(任意)</span></Label>
                  {/* refactor/list-create-content-optional (2026-04-27 #6): タイトル必須、本文は任意 */}
                  <MarkdownTextarea
                    value={createForm.content}
                    onChange={(v) => setCreateForm({ ...createForm, content: v })}
                    rows={8}
                    maxLength={10000}
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
              {filterApplied && (
                <ResizableHead columnKey="select" defaultWidth={36}>
                  <input
                    type="checkbox"
                    aria-label="表示中の編集可能行を全選択"
                    checked={allSelectableSelected}
                    disabled={selectableIds.length === 0}
                    onChange={toggleAllMemos}
                    className="rounded"
                  />
                </ResizableHead>
              )}
              <ResizableHead columnKey="title" defaultWidth={220}>タイトル</ResizableHead>
              <ResizableHead columnKey="content" defaultWidth={300}>本文</ResizableHead>
              <ResizableHead columnKey="visibility" defaultWidth={110}>公開範囲</ResizableHead>
              <ResizableHead columnKey="author" defaultWidth={120}>作成者</ResizableHead>
              <ResizableHead columnKey="updatedAt" defaultWidth={140}>更新日時</ResizableHead>
              <ResizableHead columnKey="attachments" defaultWidth={200}>添付</ResizableHead>
              <ResizableHead columnKey="actions" defaultWidth={80}>操作</ResizableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredMemos.map((m) => (
              <TableRow
                key={m.id}
                className={m.isMine ? 'cursor-pointer hover:bg-muted' : ''}
                onClick={m.isMine ? () => setEditing(m) : undefined}
              >
                {filterApplied && (
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    {m.isMine ? (
                      <input
                        type="checkbox"
                        aria-label={`${m.title} を一括編集対象に追加`}
                        checked={selectedIds.has(m.id)}
                        onChange={() => toggleOneMemo(m.id)}
                        className="rounded"
                      />
                    ) : (
                      <span className="text-xs text-muted-foreground">-</span>
                    )}
                  </TableCell>
                )}
                <TableCell className="font-medium">{m.title}</TableCell>
                <TableCell className="max-w-[min(90vw,28rem)] truncate text-sm text-foreground" title={m.content}>
                  {m.content.slice(0, 80)}
                </TableCell>
                <TableCell>
                  <Badge variant={m.visibility === 'public' ? 'default' : 'outline'}>
                    {VISIBILITY_LABELS[m.visibility] ?? m.visibility}
                  </Badge>
                </TableCell>
                {/* PR #71: /memos 画面は常に自分のメモのみ表示されるため (自分) バッジは省略 */}
                <TableCell className="text-sm text-muted-foreground">{m.authorName ?? '-'}</TableCell>
                <TableCell className="whitespace-nowrap text-sm text-muted-foreground">{formatDateTime(m.updatedAt)}</TableCell>
                <TableCell onClick={(e) => e.stopPropagation()}>
                  <AttachmentsCell items={attachmentsByEntity[m.id] ?? []} />
                </TableCell>
                {/* fix/quick-ux item 5: 編集は行クリックで実行 (line 266 の onClick={setEditing(m)})。
                    旧仕様では「編集」ボタンが冗長だったため削除し、削除のみアクション列に残す。 */}
                <TableCell onClick={(e) => e.stopPropagation()}>
                  {m.isMine && (
                    <Button variant="outline" size="sm" className="text-destructive" onClick={() => handleDelete(m)}>{t('delete')}</Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
            {filteredMemos.length === 0 && (
              <TableRow>
                <TableCell colSpan={7 + (filterApplied ? 1 : 0)} className="py-8 text-center text-muted-foreground">
                  メモがありません。右上の「メモ作成」から登録してください。
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </ResizableColumnsProvider>

      {/* 編集ダイアログ (自分のメモのみ開く) */}
      <Dialog open={editing != null} onOpenChange={(o) => { if (!o) setEditing(null); }}>
        <DialogContent className={`max-w-[min(90vw,36rem)] max-h-[85vh] overflow-y-auto ${editFsClassName}`}>
          <DialogHeader>
            <div className="flex items-center justify-between gap-2">
              <DialogTitle>メモ編集</DialogTitle>
              <EditFullscreenToggle />
            </div>
            <DialogDescription>変更内容を保存します。</DialogDescription>
          </DialogHeader>
          {editing && (
            <form onSubmit={handleEdit} className="space-y-4">
              {error && <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}
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
                <Label>本文 <span className="text-xs text-muted-foreground">(任意)</span></Label>
                {/* refactor/list-create-content-optional (2026-04-27 #6): 編集時も本文は任意 */}
                <MarkdownTextarea
                  value={editForm.content}
                  onChange={(v) => setEditForm({ ...editForm, content: v })}
                  previousValue={editing.content}
                  rows={8}
                  maxLength={10000}
                />
              </div>
              {/* URL 添付 (編集時は既存の AttachmentList で追加/削除可能) */}
              <AttachmentList
                entityType="memo"
                entityId={editing.id}
                canEdit={editing.userId === viewerUserId}
                label="参考 URL"
              />
              <Button type="submit" className="w-full">{t('save')}</Button>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
