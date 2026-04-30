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
import { useToast } from '@/components/toast-provider';
import { EntitySyncImportDialog } from '@/components/dialogs/entity-sync-import-dialog';
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
  TableBody, TableCell, TableHeader, TableRow,
} from '@/components/ui/table';
import { nativeSelectClass } from '@/components/ui/native-select-style';
import { ResizableHead } from '@/components/ui/resizable-columns';
import { ResizableTableShell } from '@/components/common/resizable-table-shell';
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
import { matchesAnyKeyword } from '@/lib/text-search';
// Phase E 要件 1〜3 (2026-04-29): 共通バッジ + 行クリック + 一括選択部品
import { VisibilityBadge } from '@/components/common/visibility-badge';
import { ClickableRow } from '@/components/common/clickable-row';
import { BulkSelectHeader, BulkSelectCell } from '@/components/common/bulk-select';
// feat/dialog-fullscreen-toggle: 文字量が多い dialog 向けの全画面トグル
import { useDialogFullscreen } from '@/components/ui/use-dialog-fullscreen';
// feat/markdown-textarea: Markdown 入力 + プレビュー + 既存値との差分表示
import { MarkdownTextarea } from '@/components/ui/markdown-textarea';
import type { MemoDTO } from '@/services/memo.service';
// PR #165: 個人「メモ一覧」での一括 visibility 変更機能 (cross-list /all-memos から移し替え)
import {
  CrossListBulkVisibilityToolbar,
  EMPTY_FILTER,
  type CrossListFilterState,
} from '@/components/cross-list-bulk-visibility-toolbar';

export function MemosClient({
  memos: initialMemos,
  viewerUserId,
}: {
  memos: MemoDTO[];
  viewerUserId: string;
}) {
  const tAction = useTranslations('action');
  const tField = useTranslations('field');
  const tMessage = useTranslations('message');
  const tMemo = useTranslations('memo');

  const MEMO_VISIBILITY_OPTIONS = [
    { value: 'private', label: tMemo('visibilityPrivateWithdraw') },
    { value: 'public', label: tMemo('visibilityPublic') },
  ];

  const VISIBILITY_LABELS: Record<string, string> = {
    private: tMemo('visibilityPrivate'),
    public: tMemo('visibilityPublic'),
  };
  const router = useRouter();
  const { withLoading } = useLoading();
  const { showSuccess, showError } = useToast();
  // PR #119: session 連携フォーマッタ
  const { formatDateTime } = useFormatters();
  const [memos, setMemos] = useState(initialMemos);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  // T-22 Phase 22d: 上書きインポート (sync-import) ダイアログ
  const [isSyncImportOpen, setIsSyncImportOpen] = useState(false);
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

  // PR #165 + Phase C 要件 18 (2026-04-28): 個人「メモ一覧」での一括 visibility 変更。
  // フィルター必須要件は撤廃し、checkbox 列とツールバーは常時表示。Memo は元から
  // isMine=true のものだけ編集できるため、checkbox は isMine=true 行のみ active。
  const [bulkFilter, setBulkFilter] = useState<CrossListFilterState>(EMPTY_FILTER);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const filteredMemos = useMemo(() => {
    let xs = memos;
    if (bulkFilter.mineOnly) xs = xs.filter((m) => m.isMine);
    if (bulkFilter.keyword.trim()) {
      // Phase C 要件 19 (2026-04-28): 空白区切りで OR 検索
      xs = xs.filter((m) => matchesAnyKeyword(bulkFilter.keyword, [m.title, m.content]));
    }
    return xs;
  }, [memos, bulkFilter]);

  const selectableIds = filteredMemos.filter((m) => m.isMine).map((m) => m.id);
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
      const msg = json.error?.message || json.error?.details?.[0]?.message || tMessage('createFailed');
      setError(msg);
      showError('メモの作成に失敗しました');
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
    showSuccess('メモを作成しました');
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
      const msg = json.error?.message || tMessage('updateFailed');
      setError(msg);
      showError('メモの更新に失敗しました');
      return;
    }
    setEditing(null);
    showSuccess('メモを更新しました');
    await reload();
  }

  async function handleDelete(memo: MemoDTO) {
    if (!confirm(tMemo('deleteConfirm', { title: memo.title }))) return;
    const res = await withLoading(() =>
      fetch(`/api/memos/${memo.id}`, { method: 'DELETE' }),
    );
    if (!res.ok) {
      showError('メモの削除に失敗しました');
      return;
    }
    showSuccess('メモを削除しました');
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
        entityLabel={tMemo('entityLabel')}
        onApplied={async () => { await reload(); }}
        // メモ一覧は対象が自分作成のみ編集可能なため、mineOnly フィルターは冗長 (項目 17)
        hideMineOnlyFilter
      />

      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">{tMemo('listTitle')}</h2>
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">{tMemo('count', { count: filteredMemos.length })}</span>
          {/* T-22 Phase 22d: sync-import (往復編集) — 自分のメモのみ */}
          <Button variant="outline" size="sm" onClick={() => window.open('/api/memos/export', '_blank')}>
            {tMemo('syncExport')}
          </Button>
          <Button variant="outline" size="sm" onClick={() => setIsSyncImportOpen(true)}>
            {tMemo('syncImportButton')}
          </Button>
          <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
            <DialogTrigger className="inline-flex shrink-0 items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-xs hover:bg-primary/90">
              {tMemo('create')}
            </DialogTrigger>
            <DialogContent className={`max-w-[min(90vw,36rem)] max-h-[85vh] overflow-y-auto ${createFsClassName}`}>
              <DialogHeader>
                <div className="flex items-center justify-between gap-2">
                  <DialogTitle>{tMemo('create')}</DialogTitle>
                  <CreateFullscreenToggle />
                </div>
                <DialogDescription>
                  {tMemo('createDescription')}
                </DialogDescription>
              </DialogHeader>
              <form onSubmit={handleCreate} className="space-y-4">
                {error && <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}
                <div className="space-y-2">
                  <Label>{tField('visibility')}</Label>
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
                  <Label>{tField('title')}</Label>
                  <Input
                    value={createForm.title}
                    onChange={(e) => setCreateForm({ ...createForm, title: e.target.value })}
                    maxLength={150}
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label>{tField('body')} <span className="text-xs text-muted-foreground">{tMemo('contentOptional')}</span></Label>
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
                  label={tMemo('referenceUrl')}
                />
                <Button type="submit" className="w-full">{tAction('create')}</Button>
              </form>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      <ResizableTableShell tableKey="all-memos">
          <TableHeader>
            <TableRow>
              <ResizableHead columnKey="select" defaultWidth={36}>
                <BulkSelectHeader
                  allSelected={allSelectableSelected}
                  totalSelectable={selectableIds.length}
                  onToggleAll={toggleAllMemos}
                  ariaLabel={tMemo('selectAllEditable')}
                />
              </ResizableHead>
              <ResizableHead columnKey="title" defaultWidth={220}>{tField('title')}</ResizableHead>
              <ResizableHead columnKey="content" defaultWidth={300}>{tField('body')}</ResizableHead>
              <ResizableHead columnKey="visibility" defaultWidth={110}>{tField('visibility')}</ResizableHead>
              <ResizableHead columnKey="author" defaultWidth={120}>{tMemo('colAuthor')}</ResizableHead>
              <ResizableHead columnKey="updatedAt" defaultWidth={140}>{tMemo('colUpdatedAt')}</ResizableHead>
              <ResizableHead columnKey="attachments" defaultWidth={200}>{tMemo('colAttachments')}</ResizableHead>
              <ResizableHead columnKey="actions" defaultWidth={80}>{tMemo('colActions')}</ResizableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredMemos.map((m) => (
              <ClickableRow
                key={m.id}
                active={m.isMine}
                onClick={() => setEditing(m)}
              >
                <TableCell onClick={(e) => e.stopPropagation()}>
                  <BulkSelectCell
                    canSelect={m.isMine}
                    selected={selectedIds.has(m.id)}
                    onToggle={() => toggleOneMemo(m.id)}
                    ariaLabel={tMemo('bulkSelectLabel', { title: m.title })}
                  />
                </TableCell>
                <TableCell className="font-medium">{m.title}</TableCell>
                <TableCell className="max-w-[min(90vw,28rem)] truncate text-sm text-foreground" title={m.content}>
                  {m.content.slice(0, 80)}
                </TableCell>
                <TableCell>
                  <VisibilityBadge
                    visibility={m.visibility}
                    label={VISIBILITY_LABELS[m.visibility] ?? m.visibility}
                  />
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
                    <Button variant="outline" size="sm" className="text-destructive" onClick={() => handleDelete(m)}>{tAction('delete')}</Button>
                  )}
                </TableCell>
              </ClickableRow>
            ))}
            {filteredMemos.length === 0 && (
              <TableRow>
                <TableCell colSpan={8} className="py-8 text-center text-muted-foreground">
                  {tMemo('empty')}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
      </ResizableTableShell>

      {/* 編集ダイアログ (自分のメモのみ開く) */}
      <Dialog open={editing != null} onOpenChange={(o) => { if (!o) setEditing(null); }}>
        <DialogContent className={`max-w-[min(90vw,36rem)] max-h-[85vh] overflow-y-auto ${editFsClassName}`}>
          <DialogHeader>
            <div className="flex items-center justify-between gap-2">
              <DialogTitle>{tMemo('edit')}</DialogTitle>
              <EditFullscreenToggle />
            </div>
            <DialogDescription>{tMemo('editDescription')}</DialogDescription>
          </DialogHeader>
          {editing && (
            <form onSubmit={handleEdit} className="space-y-4">
              {error && <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}
              <div className="space-y-2">
                <Label>{tField('visibility')}</Label>
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
                <Label>{tField('title')}</Label>
                <Input
                  value={editForm.title}
                  onChange={(e) => setEditForm({ ...editForm, title: e.target.value })}
                  maxLength={150}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label>{tField('body')} <span className="text-xs text-muted-foreground">{tMemo('contentOptional')}</span></Label>
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
                label={tMemo('referenceUrl')}
              />
              <Button type="submit" className="w-full">{tAction('save')}</Button>
            </form>
          )}
        </DialogContent>
      </Dialog>

      {/* T-22 Phase 22d: 上書きインポート (sync-import) ダイアログ */}
      <EntitySyncImportDialog
        apiBasePath="/api/memos/sync-import"
        i18nNamespace="memo.syncImport"
        open={isSyncImportOpen}
        onOpenChange={setIsSyncImportOpen}
        onImported={async () => { await reload(); }}
      />
    </div>
  );
}
