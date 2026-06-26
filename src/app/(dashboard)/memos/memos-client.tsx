'use client';

/**
 * 全メモ画面クライアント (PR #70)。
 *
 * - 自分のメモ (private/public すべて) + 他人の public メモを表示
 * - 作成/編集ダイアログで CRUD、他人のメモは参照のみ
 * - URL 添付 (AttachmentList, entityType='memo') を編集ダイアログに組み込み
 * - 列幅リサイズ (PR #68) + 添付列 (PR #67) のパターンを踏襲
 */

import { useCallback, useMemo, useState } from 'react';
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
import { SortableResizableHead } from '@/components/sort/sortable-resizable-head';
import { useMultiSort } from '@/components/sort/use-multi-sort';
import { multiSort } from '@/lib/multi-sort';
import { ResizableTableShell } from '@/components/common/resizable-table-shell';
import { useListSearchParams } from '@/components/common/use-list-search-params';
import { useTablePagination, TablePagination } from '@/components/common/table-pagination';
import { AttachmentList } from '@/components/attachments/attachment-list';
// PR #213 (2026-05-01): 個人メモ画面にもコメント機能を追加
import { CommentSection } from '@/components/comments/comment-section';
import {
  StagedAttachmentsInput,
  persistStagedAttachments,
  type StagedAttachment,
} from '@/components/attachments/staged-attachments-input';
import { useBatchAttachments } from '@/components/attachments/use-batch-attachments';
import { AttachmentsCell } from '@/components/attachments/attachments-cell';
// 2026-06-03: 他「○○一覧」と列構成を統一 — リンク列 (url 型) と添付列 (ファイル本体) を分離。
import { LinksCell } from '@/components/attachments/links-cell';
// PR #119: session 連携フォーマッタ
import { useFormatters } from '@/lib/use-formatters';
import { matchesAnyKeyword } from '@/lib/text-search';
// Phase E 要件 1〜3 (2026-04-29): 共通行クリック + 一括選択部品
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
  type CrossListFilterState,
} from '@/components/cross-list-bulk-visibility-toolbar';
// fix/chat-search-result-links: チャット意味検索の結果カードから `/memos?memoId=...` で
// 自分の memo (private 含む) を auto-open するために追加。同パターンは /all-memos 側にも実装済。
import { useAutoOpenDialog } from '@/components/common/use-auto-open-dialog';

// PR feat/sortable-columns: カラム列キー → 行値の getter。multiSort の比較に使う。
function getMemoSortValue(m: MemoDTO, columnKey: string): unknown {
  switch (columnKey) {
    case 'title': return m.title;
    case 'content': return m.content;
    case 'createdAt': return m.createdAt;
    case 'updatedAt': return m.updatedAt;
    default: return null;
  }
}

export function MemosClient({
  memos: initialMemos,
  viewerUserId,
  dataLoadError = false,
  initialKeyword = '',
  initialMineOnly = false,
}: {
  memos: MemoDTO[];
  viewerUserId: string;
  /**
   * fix/admin-users-defensive-render 横展開 (2026-05-15): server 側 data 取得が失敗した時に
   * 表示する警告バナーの可否。デフォルト false (= 正常)。
   */
  dataLoadError?: boolean;
  /** PR #425 (2026-05-22) KDD §5.X+102: URL ?keyword=&mineOnly= 復元用 */
  initialKeyword?: string;
  initialMineOnly?: boolean;
}) {
  const tAction = useTranslations('action');
  const tField = useTranslations('field');
  const tMessage = useTranslations('message');
  const tMemo = useTranslations('memo');
  const tCommon = useTranslations('common');

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
  // 作成日時/更新日時は監査列のため秒まで表示 (formatDateTimeSeconds = 全画面共通の設計)
  const { formatDateTimeSeconds } = useFormatters();
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
  //
  // PR #425 (2026-05-22) KDD §5.X+102: URL ?keyword=&mineOnly= 永続化に切替。
  //   useListSearchParams で keyword + mineOnly (string 'true'/'') を管理。
  //   bulkFilter は派生 state として CrossListFilterState 形に変換して渡す。
  const { keyword: kwState, setKeyword: setKwState, filters: bulkFilters, setFilter: setBulkFilterParam } = useListSearchParams<{ mineOnly: string }>({
    initialKeyword,
    initialFilters: { mineOnly: initialMineOnly ? 'true' : '' },
  });
  const bulkFilter: CrossListFilterState = useMemo(
    () => ({ keyword: kwState, mineOnly: bulkFilters.mineOnly === 'true' }),
    [kwState, bulkFilters.mineOnly],
  );
  const setBulkFilter = useCallback((next: CrossListFilterState) => {
    if (next.keyword !== kwState) setKwState(next.keyword);
    const nextMineOnlyParam = next.mineOnly ? 'true' : '';
    if (nextMineOnlyParam !== bulkFilters.mineOnly) setBulkFilterParam('mineOnly', nextMineOnlyParam);
  }, [kwState, bulkFilters.mineOnly, setKwState, setBulkFilterParam]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // PR feat/sortable-columns (2026-05-01): カラムソート (sessionStorage 永続化、複数列対応)。
  const { sortState, setSortColumn } = useMultiSort('sort:memos');

  // fix/chat-search-result-links: チャット意味検索が「自分のメモ」(public/private 問わず) を
  // 検索結果に含むため、`/memos?memoId=...` で該当 memo の編集ダイアログを auto-open する。
  // listMyMemos が viewer 自身のメモのみ返すため、`items: memos` に対する find で常にヒットする。
  useAutoOpenDialog<MemoDTO>({
    queryKey: 'memoId',
    items: memos,
    onOpen: (m) => setEditing(m),
  });

  const filteredMemos = useMemo(() => {
    let xs: MemoDTO[] = memos;
    if (bulkFilter.mineOnly) xs = xs.filter((m) => m.isMine);
    if (bulkFilter.keyword.trim()) {
      // Phase C 要件 19 (2026-04-28): 空白区切りで OR 検索
      xs = xs.filter((m) => matchesAnyKeyword(bulkFilter.keyword, [m.title, m.content]));
    }
    return multiSort(xs, sortState, getMemoSortValue);
  }, [memos, bulkFilter, sortState]);

  const { pageItems, page, pageCount, setPage } = useTablePagination(
    filteredMemos,
    `${kwState}|${bulkFilters.mineOnly}`,
  );

  // fix/list-export-import-bugs (2026-05-26): チェックボックスは export + bulk visibility 兼用に拡張。
  //   全行選択可とし、bulk visibility は サーバ側で per-row 認可 (canEdit=false は silent skip)。
  const selectableIds = filteredMemos.map((m) => m.id);
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

  // PR-1 perf (2026-05-29): フォーム setter を functional updater + useCallback に統一。
  //   詳細は projects-client.tsx 同パターン参照。
  const updateCreateField = useCallback(
    <K extends keyof typeof createForm>(key: K, value: (typeof createForm)[K]) => {
      setCreateForm((prev) => ({ ...prev, [key]: value }));
    },
    [],
  );

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
      showError(tMemo('toastCreateFailed'));
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
    showSuccess(tMemo('toastCreateSuccess'));
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
  // PR-1 perf (2026-05-29): 編集フォーム setter も functional updater + useCallback に統一。
  const updateEditField = useCallback(
    <K extends keyof EditFormState>(key: K, value: EditFormState[K]) => {
      setEditForm((prev) => ({ ...prev, [key]: value }));
    },
    [],
  );
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
      showError(tMemo('toastUpdateFailed'));
      return;
    }
    setEditing(null);
    showSuccess(tMemo('toastUpdateSuccess'));
    await reload();
  }

  async function handleDelete(memo: MemoDTO) {
    if (!confirm(tMemo('deleteConfirm', { title: memo.title }))) return;
    const res = await withLoading(() =>
      fetch(`/api/memos/${memo.id}`, { method: 'DELETE' }),
    );
    if (!res.ok) {
      showError(tMemo('deleteFailed'));
      return;
    }
    showSuccess(tMemo('deleteSuccess'));
    await reload();
  }

  // fix/list-export-import-bugs (2026-05-26): チェックされている行のみエクスポート対象に絞る。
  //   selectedIds.size === 0 のとき全件 export (tasks 画面と同パターン)。
  async function handleSyncExport() {
    const body: Record<string, unknown> = {};
    if (selectedIds.size > 0) body.ids = [...selectedIds];
    const res = await withLoading(() =>
      fetch('/api/memos/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
    if (!res.ok) {
      showError(tMemo('toastExportFailed'));
      return;
    }
    const csvText = await res.text();
    const blob = new Blob(['﻿' + csvText], { type: 'text/csv; charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'memos_sync.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  // initialMemos の更新に合わせて state 側も追従 (Derived State)
  // PR fix/eslint-config-next-16.2.6 (2026-05-11):
  //   eslint-config-next 16.2.6 が `react-hooks/set-state-in-effect` を新たに enforce。
  //   旧実装: `useEffect(() => setMemos(initialMemos), [initialMemos])` は violation。
  //   → React 公式推奨の **「前回 prop を比較して render 中に setState する」** パターンに変更。
  //   ref: https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes
  const [prevInitialMemos, setPrevInitialMemos] = useState(initialMemos);
  if (prevInitialMemos !== initialMemos) {
    setPrevInitialMemos(initialMemos);
    setMemos(initialMemos);
  }

  return (
    <div className="space-y-6">
      {/* fix/admin-users-defensive-render 横展開 (2026-05-15): server data load 失敗時のバナー。
          listMyMemos が throw した場合、画面は空表示になるが新規作成等の操作は維持。 */}
      {dataLoadError && (
        <div className="rounded border border-destructive/30 bg-destructive/10 p-3 text-sm">
          <p className="font-semibold">{tMemo('loadFailedTitle')}</p>
          <p className="mt-1 text-muted-foreground">
            {tMemo('loadFailedMessageRetry')}{' '}{tMemo('loadFailedMessageContact')}
          </p>
        </div>
      )}
      {/* 2026-06-03: 他「○○一覧」と UI 配置を統一。順序を
          ① 件数 + エクスポート/インポート/作成ボタン (最上部・右寄せ) → ② フィルター + 一括編集ツールバー
          → ③ 列幅リセット + テーブル に揃える (旧実装はツールバーが最上部 + 画面見出しがあり他一覧と不一致だった)。
          画面見出し (h2「メモ一覧」) は他「○○一覧」に合わせて撤去。 */}
      <div className="flex items-center justify-end">
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">{tCommon('itemCount', { count: filteredMemos.length })}</span>
          {/* T-22 Phase 22d: sync-import (往復編集) — 自分のメモのみ */}
          <Button variant="outline" size="sm" onClick={handleSyncExport}>
            {tMemo('syncExport')}
          </Button>
          <Button variant="outline" size="sm" onClick={() => setIsSyncImportOpen(true)}>
            {tMemo('syncImportButton')}
          </Button>
          <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
            <DialogTrigger className="inline-flex shrink-0 items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-xs hover:bg-primary/90">
              {tMemo('create')}
            </DialogTrigger>
            <DialogContent className={`max-w-[min(90vw,36rem)] max-h-[85vh] overflow-x-hidden overflow-y-auto ${createFsClassName}`}>
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
                    onChange={(e) => updateCreateField('visibility', e.target.value)}
                    className={nativeSelectClass}
                  >
                    {Object.entries(VISIBILITY_LABELS).map(([k, l]) => (
                      <option key={k} value={k}>{l}</option>
                    ))}
                  </select>
                </div>
                <div className="space-y-2">
                  <Label>
                    {tField('title')}
                    {/* 2026-05-11: 公開範囲 = 自分のみ なら任意 (一時保存可)、全メンバー なら必須 */}
                    {createForm.visibility === 'private' && (
                      <span className="ml-2 text-xs text-muted-foreground">{tMemo('contentOptional')}</span>
                    )}
                  </Label>
                  <Input
                    value={createForm.title}
                    onChange={(e) => updateCreateField('title', e.target.value)}
                    maxLength={150}
                    required={createForm.visibility === 'public'}
                  />
                </div>
                <div className="space-y-2">
                  <Label>{tField('body')} <span className="text-xs text-muted-foreground">{tMemo('contentOptional')}</span></Label>
                  {/* refactor/list-create-content-optional (2026-04-27 #6): タイトル必須、本文は任意 */}
                  <MarkdownTextarea
                    value={createForm.content}
                    onChange={(v) => updateCreateField('content', v)}
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

      {/* PR #165: 個人「メモ一覧」での一括 visibility 変更。
          他「○○一覧」と同じく タイトル/ボタン行の下・テーブルの上に配置 (2026-06-03 位置統一)。 */}
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
              <SortableResizableHead columnKey="title" defaultWidth={220} label={tField('title')} sortState={sortState} onSortChange={setSortColumn} />
              <SortableResizableHead columnKey="content" defaultWidth={300} label={tField('body')} sortState={sortState} onSortChange={setSortColumn} />
              <SortableResizableHead columnKey="createdAt" defaultWidth={150} label={tMemo('colCreatedAt')} sortState={sortState} onSortChange={setSortColumn} />
              <SortableResizableHead columnKey="updatedAt" defaultWidth={150} label={tMemo('colUpdatedAt')} sortState={sortState} onSortChange={setSortColumn} />
              <ResizableHead columnKey="links" defaultWidth={200}>{tMemo('colLinks')}</ResizableHead>
              <ResizableHead columnKey="attachments" defaultWidth={180}>{tMemo('colAttachments')}</ResizableHead>
              <ResizableHead columnKey="actions" defaultWidth={80}>{tMemo('colActions')}</ResizableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {pageItems.map((m) => (
              <ClickableRow
                key={m.id}
                active={m.canEdit}
                onClick={() => setEditing(m)}
              >
                <TableCell onClick={(e) => e.stopPropagation()}>
                  {/* fix/list-export-import-bugs (2026-05-26): export 対象指定と bulk visibility 兼用のため全行チェック可 */}
                  <BulkSelectCell
                    canSelect={true}
                    selected={selectedIds.has(m.id)}
                    onToggle={() => toggleOneMemo(m.id)}
                    ariaLabel={tMemo('bulkSelectLabel', { title: m.title })}
                  />
                </TableCell>
                <TableCell className="font-medium">{m.title}</TableCell>
                <TableCell className="max-w-[min(90vw,28rem)] truncate text-sm text-foreground" title={m.content}>
                  {m.content.slice(0, 80)}
                </TableCell>
                {/* PR #71: /memos 画面は常に自分のメモのみ表示されるため作成者列は省略。
                    公開範囲は上部の一括変更ツールバーで操作するため列からは撤去 (2026-06-03)。 */}
                <TableCell className="whitespace-nowrap text-sm text-muted-foreground">{formatDateTimeSeconds(m.createdAt)}</TableCell>
                <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                  {m.updatedAt !== m.createdAt ? formatDateTimeSeconds(m.updatedAt) : '—'}
                </TableCell>
                {/* リンク列 (url 型添付を縦に複数行) / 添付列 (ファイル本体のみ) */}
                <TableCell onClick={(e) => e.stopPropagation()}>
                  <LinksCell items={attachmentsByEntity[m.id] ?? []} />
                </TableCell>
                <TableCell onClick={(e) => e.stopPropagation()}>
                  <AttachmentsCell items={(attachmentsByEntity[m.id] ?? []).filter((a) => a.storageProvider === 'supabase')} />
                </TableCell>
                {/* fix/quick-ux item 5: 編集は行クリックで実行 (line 266 の onClick={setEditing(m)})。
                    旧仕様では「編集」ボタンが冗長だったため削除し、削除のみアクション列に残す。 */}
                <TableCell onClick={(e) => e.stopPropagation()}>
                  {m.canEdit && (
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

      <TablePagination page={page} pageCount={pageCount} onPageChange={setPage} />

      {/* 編集ダイアログ (自分のメモのみ開く) */}
      <Dialog open={editing != null} onOpenChange={(o) => { if (!o) setEditing(null); }}>
        <DialogContent className={`max-w-[min(90vw,36rem)] max-h-[85vh] overflow-x-hidden overflow-y-auto ${editFsClassName}`}>
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
                  onChange={(e) => updateEditField('visibility', e.target.value)}
                  className={nativeSelectClass}
                >
                  {Object.entries(VISIBILITY_LABELS).map(([k, l]) => (
                    <option key={k} value={k}>{l}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-2">
                <Label>
                  {tField('title')}
                  {/* 2026-05-11: 編集時も visibility 連動で required を切替 */}
                  {editForm.visibility === 'private' && (
                    <span className="ml-2 text-xs text-muted-foreground">{tMemo('contentOptional')}</span>
                  )}
                </Label>
                <Input
                  value={editForm.title}
                  onChange={(e) => updateEditField('title', e.target.value)}
                  maxLength={150}
                  required={editForm.visibility === 'public'}
                />
              </div>
              <div className="space-y-2">
                <Label>{tField('body')} <span className="text-xs text-muted-foreground">{tMemo('contentOptional')}</span></Label>
                {/* refactor/list-create-content-optional (2026-04-27 #6): 編集時も本文は任意 */}
                <MarkdownTextarea
                  value={editForm.content}
                  onChange={(v) => updateEditField('content', v)}
                  previousValue={editing.content}
                  rows={8}
                  maxLength={10000}
                />
              </div>
              {/* URL 添付 (編集時は既存の AttachmentList で追加/削除可能) */}
              <AttachmentList
                entityType="memo"
                entityId={editing.id}
                canEdit={editing.canEdit}
                label={tMemo('referenceUrl')}
              />
              <Button type="submit" className="w-full">{tAction('save')}</Button>
              {/* PR #213: 個人メモにもコメント機能 (全メモと同 UX)。form の外に配置することで
                  保存ボタンと干渉しない。public memo は他人もコメント可、draft は本人のみ。 */}
              <CommentSection
                entityType="memo"
                entityId={editing.id}
              />
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
