'use client';

/**
 * 振り返り画面 (プロジェクト詳細タブ配下) のクライアントコンポーネント。
 *
 * 役割:
 *   プロジェクト振り返り (KPT 風: 計画/実績総括 + 良かった点 / 課題 / 次回事項) の
 *   一覧 / 新規作成 / 編集 / 削除を管理する (項目 10: コメント機能は UI 非表示化、API は残置)。
 *
 * 公開範囲:
 *   visibility='draft' は作成者本人 + admin のみ、'public' は「全振り返り」横断画面に表示。
 *
 * コメント機能:
 *   各振り返り配下に時系列コメントを追加可能。retrospective_comments テーブル。
 *
 * 認可: canCreate (作成) / 自分作成判定 (編集・削除) を prop で受け取る。
 *       コメント機能は項目 10 で UI 非表示化、API/DB/service は温存。
 * API:
 *   - /api/projects/[id]/retrospectives (GET/POST)
 *   - /api/projects/[id]/retrospectives/[retroId] (PATCH/DELETE)
 *   - /api/projects/[id]/retrospectives/[retroId]/comments (POST)
 *
 * 関連:
 *   - SPECIFICATION.md (振り返り画面)
 *   - DESIGN.md §23 (核心機能: 過去振り返りの提案連動)
 */

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useLoading } from '@/components/loading-overlay';
import { useToast } from '@/components/toast-provider';
import { Button } from '@/components/ui/button';
import { matchesAnyKeyword } from '@/lib/text-search';
// UI_PATTERNS §35 (2026-05-24): カードから軽量テーブルに移行 (5 一覧 UI 統一)
import { VisibilityBadge } from '@/components/common/visibility-badge';
import { ClickableRow } from '@/components/common/clickable-row';
import { BulkSelectHeader, BulkSelectCell } from '@/components/common/bulk-select';
import {
  TableBody, TableCell, TableHeader, TableRow,
} from '@/components/ui/table';
import { ResizableHead } from '@/components/ui/resizable-columns';
import { ResizableTableShell } from '@/components/common/resizable-table-shell';
import { SortableResizableHead } from '@/components/sort/sortable-resizable-head';
import { useMultiSort } from '@/components/sort/use-multi-sort';
import { multiSort } from '@/lib/multi-sort';
import { useFormatters } from '@/lib/use-formatters';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';
import { RetrospectiveEditDialog } from '@/components/dialogs/retrospective-edit-dialog';
import { EntitySyncImportDialog } from '@/components/dialogs/entity-sync-import-dialog';
import { DateFieldWithActions } from '@/components/ui/date-field-with-actions';
import {
  StagedAttachmentsInput,
  persistStagedAttachments,
  type StagedAttachment,
} from '@/components/attachments/staged-attachments-input';
import { nativeSelectClass } from '@/components/ui/native-select-style';
import { VISIBILITIES } from '@/types';
import type { RetroDTO } from '@/services/retrospective.service';
// PR #168: 一覧画面に添付列を表示 (横展開)
import { useBatchAttachments } from '@/components/attachments/use-batch-attachments';
import { AttachmentsCell } from '@/components/attachments/attachments-cell';
// feat/dialog-fullscreen-toggle: 文字量が多い dialog 向けの全画面トグル
import { useDialogFullscreen } from '@/components/ui/use-dialog-fullscreen';
// feat/markdown-textarea: Markdown 入力 + プレビュー (create dialog のため previousValue なし)
import { MarkdownTextarea } from '@/components/ui/markdown-textarea';
// PR #165: project-level「振り返り一覧」での一括 visibility 変更 (cross-list /retrospectives から移し替え)
import {
  CrossListBulkVisibilityToolbar,
  EMPTY_FILTER,
  type CrossListFilterState,
} from '@/components/cross-list-bulk-visibility-toolbar';

// NOTE: i18n labels are resolved inside the component (translations require a hook context).
function buildRetroVisibilityOptions(t: (key: string) => string) {
  return [
    { value: 'draft', label: t('visibilityDraftLabel') },
    { value: 'public', label: t('visibilityPublicLabel') },
  ];
}

// UI_PATTERNS §35 (2026-05-24): 軽量テーブル化に伴うカラムソート getter。
function getProjectRetroSortValue(r: RetroDTO, columnKey: string): unknown {
  switch (columnKey) {
    case 'conductedDate': return r.conductedDate;
    case 'state': return r.state;
    case 'visibility': return r.visibility;
    case 'createdBy': return r.createdBy;
    case 'createdAt': return r.createdAt;
    default: return null;
  }
}

type Props = {
  projectId: string;
  retros: RetroDTO[];
  /** feat/asset-assignee-expansion (2026-05-26): 担当者 selector の選択肢 (任意) */
  members?: { userId: string; userName: string }[];
  /** 2026-04-24: 振り返り作成ボタンの表示可否 (実際の ProjectMember の pm_tl/member のみ true) */
  canCreate: boolean;
  /** 作成者本人判定用 (createdBy === currentUserId で編集/削除許可) */
  currentUserId: string;
  /** CRUD 後に呼び出す再取得ハンドラ（未指定時は router.refresh フォールバック）*/
  onReload?: () => Promise<void> | void;
};

export function RetrospectivesClient({ projectId, retros, members, canCreate, currentUserId, onReload }: Props) {
  const t = useTranslations('action');
  const tRetro = useTranslations('retro');
  const tCommon = useTranslations('common');
  const RETRO_VISIBILITY_OPTIONS = buildRetroVisibilityOptions(tRetro);
  const router = useRouter();
  const { withLoading } = useLoading();
  const { showSuccess, showError } = useToast();
  const { formatDate } = useFormatters();
  // UI_PATTERNS §35: カラムソート (sessionStorage 永続化、複数列対応)
  const { sortState, setSortColumn } = useMultiSort(`sort:project-retrospectives-${projectId}`);
  const reload = useCallback(async () => {
    if (onReload) {
      await onReload();
    } else {
      router.refresh();
    }
  }, [onReload, router]);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  // T-22 Phase 22b: 上書きインポート (sync-import) ダイアログ
  const [isSyncImportOpen, setIsSyncImportOpen] = useState(false);
  // 項目 10: コメント機能 UI 非表示化に伴い state 削除。API は残置。
  const [error, setError] = useState('');
  // 行 (カード) クリックで開く編集ダイアログ (PR #56 Req 8)
  const [editingRetro, setEditingRetro] = useState<RetroDTO | null>(null);
  // feat/dialog-fullscreen-toggle: 振り返り作成 dialog の全画面トグル
  const { fullscreenClassName: createFsClassName, FullscreenToggle: CreateFullscreenToggle } = useDialogFullscreen();

  const [form, setForm] = useState({
    conductedDate: new Date().toISOString().split('T')[0],
    planSummary: '',
    actualSummary: '',
    goodPoints: '',
    problems: '',
    improvements: '',
    visibility: 'draft',
  });

  // PR #67: 作成時にステージする添付 URL
  const [stagedCreateAttachments, setStagedCreateAttachments] = useState<StagedAttachment[]>([]);

  // PR #165 + Phase C 要件 18 (2026-04-28): project-level「振り返り一覧」での一括 visibility 変更。
  // フィルター必須要件は撤廃し、checkbox 列とツールバーは常時表示。
  const [bulkFilter, setBulkFilter] = useState<CrossListFilterState>(EMPTY_FILTER);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const filteredRetros = (() => {
    let xs = retros;
    if (bulkFilter.mineOnly) xs = xs.filter((r) => r.createdBy === currentUserId);
    if (bulkFilter.keyword.trim()) {
      // Phase C 要件 19 (2026-04-28): 空白区切りで OR 検索
      xs = xs.filter((r) =>
        matchesAnyKeyword(bulkFilter.keyword, [
          r.planSummary,
          r.actualSummary,
          r.goodPoints,
          r.problems,
          r.improvements,
        ]),
      );
    }
    // UI_PATTERNS §35: 軽量テーブル化に伴い multi-sort 適用
    return multiSort(xs, sortState, getProjectRetroSortValue);
  })();

  // feat/asset-assignee-expansion (2026-05-26): 作成者 OR 担当者を編集可能 (= bulk 対象)
  const selectableRetroIds = filteredRetros
    .filter((r) => r.createdBy === currentUserId || r.assigneeId === currentUserId)
    .map((r) => r.id);
  const allRetrosSelected
    = selectableRetroIds.length > 0 && selectableRetroIds.every((id) => selectedIds.has(id));

  // PR #168: 添付バッチ取得 (他エンティティ一覧と同パターン)
  const attachmentsByEntity = useBatchAttachments('retrospective', filteredRetros.map((r) => r.id));

  function toggleOneRetro(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleAllRetros() {
    setSelectedIds(allRetrosSelected ? new Set() : new Set(selectableRetroIds));
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    // 2026-05-11: 「自分のみ (draft)」保存時は conductedDate を空にできる仕様のため、
    //   '' を undefined に変換してから送信する (validator の regex で '' は弾かれるため、
    //   サーバ側 default で当日日付を補完)。
    const payload: Record<string, unknown> = { ...form };
    if (form.conductedDate === '') {
      delete payload.conductedDate;
    }
    const res = await withLoading(() =>
      fetch(`/api/projects/${projectId}/retrospectives`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }),
    );
    if (!res.ok) {
      const json = await res.json();
      const msg = json.error?.message || json.error?.details?.[0]?.message || tRetro('createFailed');
      setError(msg);
      showError('振り返りの作成に失敗しました');
      return;
    }
    // PR #67: 作成成功直後にステージされた添付を一括 POST
    const json = await res.json();
    if (stagedCreateAttachments.length > 0 && json.data?.id) {
      await persistStagedAttachments({
        entityType: 'retrospective',
        entityId: json.data.id,
        items: stagedCreateAttachments,
      });
    }
    setStagedCreateAttachments([]);

    setIsCreateOpen(false);
    setForm({ conductedDate: new Date().toISOString().split('T')[0], planSummary: '', actualSummary: '', goodPoints: '', problems: '', improvements: '', visibility: 'draft' });
    showSuccess('振り返りを作成しました');
    await reload();
  }

  async function handleConfirm(retroId: string) {
    // PR #57 修正: 以前は POST /retrospectives に { action: 'confirm', retroId } を送って
    // 400 (create schema 違反) になっていた。正しい経路である
    // PATCH /retrospectives/[retroId] に state='confirmed' を送る。
    const res = await fetch(`/api/projects/${projectId}/retrospectives/${retroId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: 'confirmed' }),
    });
    if (!res.ok) {
      showError('振り返りの確定に失敗しました');
      return;
    }
    showSuccess('振り返りを確定しました');
    await reload();
  }

  async function handleDelete(retroId: string) {
    // PR #59: 振り返りリストからの削除 UI を追加 (リスク/課題・ナレッジと同様の DRY 化)。
    // 実 API は PR #52 で新設済の DELETE /api/projects/:pid/retrospectives/:retroId を使用。
    if (!confirm(tRetro('deleteConfirm'))) return;
    const res = await withLoading(() =>
      fetch(`/api/projects/${projectId}/retrospectives/${retroId}`, { method: 'DELETE' }),
    );
    if (!res.ok) {
      showError('振り返りの削除に失敗しました');
      return;
    }
    showSuccess('振り返りを削除しました');
    await reload();
  }

  // 項目 10: handleComment は UI 非表示化に伴い削除。API endpoint は残置。

  return (
    <div className="space-y-6">
      {/* Phase A 要件 6: h2 ページタイトル削除 (タブ名と重複のため) */}
      <div className="flex items-center justify-end">
        <div className="flex gap-2">
        {/* T-22 Phase 22b: sync-import (往復編集) */}
        {canCreate && (
          <>
            <Button variant="outline" onClick={() => window.open(`/api/projects/${projectId}/retrospectives/export?mode=sync`, '_blank')}>
              {tRetro('syncExport')}
            </Button>
            <Button variant="outline" onClick={() => setIsSyncImportOpen(true)}>
              {tRetro('syncImportButton')}
            </Button>
          </>
        )}
        {canCreate && (
          <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
            <DialogTrigger className="inline-flex shrink-0 items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-xs hover:bg-primary/90">{tRetro('createTitle')}</DialogTrigger>
            <DialogContent className={`max-w-[min(90vw,42rem)] max-h-[80vh] overflow-y-auto ${createFsClassName}`}>
              <DialogHeader>
                <div className="flex items-center justify-between gap-2">
                  <DialogTitle>{tRetro('createTitle')}</DialogTitle>
                  <CreateFullscreenToggle />
                </div>
                <DialogDescription>{tRetro('createDescription')}</DialogDescription>
              </DialogHeader>
              <form onSubmit={handleCreate} className="space-y-4">
                {error && <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}
                {/* PR #63: 公開範囲を最上位に配置 (設定忘れ防止) */}
                <div className="space-y-2">
                  <Label>{tRetro('visibility')}</Label>
                  <select value={form.visibility} onChange={(e) => setForm({ ...form, visibility: e.target.value })} className={nativeSelectClass}>
                    {Object.entries(VISIBILITIES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                  </select>
                </div>
                <div className="space-y-2">
                  <Label>
                    {tRetro('conductedDate')}
                    {/* 2026-05-11: 公開範囲 = 自分のみ (draft) なら任意 (サーバ側で当日日付を default 補完) */}
                    {form.visibility === 'draft' && (
                      <span className="ml-2 text-xs text-muted-foreground">{tRetro('optional')}</span>
                    )}
                  </Label>
                  <DateFieldWithActions
                    value={form.conductedDate}
                    onChange={(v) => setForm({ ...form, conductedDate: v })}
                    required={form.visibility === 'public'}
                    hideClear
                  />
                </div>
                {/* refactor/list-create-content-optional (2026-04-27 #6): 5 セクションは全て任意 (実施日のみ必須) */}
                <div className="space-y-2">
                  <Label>{tRetro('planSummary')} <span className="text-xs text-muted-foreground">{tRetro('optional')}</span></Label>
                  <MarkdownTextarea value={form.planSummary} onChange={(v) => setForm({ ...form, planSummary: v })} rows={3} maxLength={2000} />
                </div>
                <div className="space-y-2">
                  <Label>{tRetro('actualSummary')} <span className="text-xs text-muted-foreground">{tRetro('optional')}</span></Label>
                  <MarkdownTextarea value={form.actualSummary} onChange={(v) => setForm({ ...form, actualSummary: v })} rows={3} maxLength={2000} />
                </div>
                <div className="space-y-2">
                  <Label>{tRetro('goodPoints')} <span className="text-xs text-muted-foreground">{tRetro('optional')}</span></Label>
                  <MarkdownTextarea value={form.goodPoints} onChange={(v) => setForm({ ...form, goodPoints: v })} rows={3} maxLength={3000} />
                </div>
                <div className="space-y-2">
                  <Label>{tRetro('problems')} <span className="text-xs text-muted-foreground">{tRetro('optional')}</span></Label>
                  <MarkdownTextarea value={form.problems} onChange={(v) => setForm({ ...form, problems: v })} rows={3} maxLength={3000} />
                </div>
                <div className="space-y-2">
                  <Label>{tRetro('improvements')} <span className="text-xs text-muted-foreground">{tRetro('optional')}</span></Label>
                  <MarkdownTextarea value={form.improvements} onChange={(v) => setForm({ ...form, improvements: v })} rows={3} maxLength={3000} />
                </div>
                {/* PR #67: 作成と同時に議事録・発表資料等の関連 URL を登録可能 */}
                <StagedAttachmentsInput
                  value={stagedCreateAttachments}
                  onChange={setStagedCreateAttachments}
                />
                <Button type="submit" className="w-full">{tRetro('create')}</Button>
              </form>
            </DialogContent>
          </Dialog>
        )}
        </div>
      </div>

      {/* T-22 Phase 22b: 上書きインポート (sync-import) ダイアログ */}
      <EntitySyncImportDialog
        apiBasePath={`/api/projects/${projectId}/retrospectives/sync-import`}
        i18nNamespace="retro.syncImport"
        open={isSyncImportOpen}
        onOpenChange={setIsSyncImportOpen}
        onImported={async () => { await reload(); }}
      />

      {/* PR #165: project-level「振り返り一覧」での一括 visibility 変更 */}
      <CrossListBulkVisibilityToolbar
        endpoint={`/api/projects/${projectId}/retrospectives/bulk`}
        formIdPrefix={`project-retros-${projectId}`}
        filter={bulkFilter}
        onFilterChange={setBulkFilter}
        selectedIds={selectedIds}
        onSelectionClear={() => setSelectedIds(new Set())}
        visibilityOptions={RETRO_VISIBILITY_OPTIONS}
        entityLabel={tRetro('title')}
        onApplied={async () => { await reload(); }}
      />

      {/* UI_PATTERNS §35 (2026-05-24): 軽量テーブル統一。詳細 (planSummary / actualSummary /
          goodPoints / problems / improvements) は行クリックで RetrospectiveEditDialog
          (readOnly 判定付き) を開いて表示する。 */}
      <ResizableTableShell tableKey={`project-retrospectives-${projectId}`}>
        <TableHeader>
          <TableRow>
            <ResizableHead columnKey="select" defaultWidth={36}>
              <BulkSelectHeader
                allSelected={allRetrosSelected}
                totalSelectable={selectableRetroIds.length}
                onToggleAll={toggleAllRetros}
                ariaLabel={tRetro('selectAllOwn')}
              />
            </ResizableHead>
            <SortableResizableHead columnKey="conductedDate" defaultWidth={130} label={tRetro('conductedDate')} sortState={sortState} onSortChange={setSortColumn} />
            <SortableResizableHead columnKey="state" defaultWidth={100} label={tRetro('state')} sortState={sortState} onSortChange={setSortColumn} />
            <SortableResizableHead columnKey="visibility" defaultWidth={90} label={tRetro('visibility')} sortState={sortState} onSortChange={setSortColumn} />
            <SortableResizableHead columnKey="createdBy" defaultWidth={120} label={tRetro('createdBy')} sortState={sortState} onSortChange={setSortColumn} />
            <SortableResizableHead columnKey="createdAt" defaultWidth={130} label={tRetro('createdAt')} sortState={sortState} onSortChange={setSortColumn} />
            <ResizableHead columnKey="attachments" defaultWidth={180}>{tRetro('attachment')}</ResizableHead>
            {/* 2026-04-24 / §35: 作成者本人だけが操作ボタンを使うので、自分の行が 1 つでもあれば列を出す。
                feat/asset-assignee-expansion (2026-05-26): 担当者も操作可能なので OR で拡張。 */}
            {filteredRetros.some((r) => r.createdBy === currentUserId || r.assigneeId === currentUserId) && (
              <ResizableHead columnKey="actions" defaultWidth={160}>{tRetro('actions')}</ResizableHead>
            )}
          </TableRow>
        </TableHeader>
        <TableBody>
          {filteredRetros.length === 0 ? (
            <TableRow>
              <TableCell
                colSpan={filteredRetros.some((r) => r.createdBy === currentUserId || r.assigneeId === currentUserId) ? 8 : 7}
                className="py-8 text-center text-muted-foreground"
              >
                {tRetro('noneInList')}
              </TableCell>
            </TableRow>
          ) : (
            filteredRetros.map((retro) => {
              // feat/asset-assignee-expansion (2026-05-26): 作成者 OR 担当者で編集/確定/削除可
              const isOwner = retro.createdBy === currentUserId || retro.assigneeId === currentUserId;
              return (
                <ClickableRow key={retro.id} onClick={() => setEditingRetro(retro)}>
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <BulkSelectCell
                      canSelect={isOwner}
                      hidePlaceholderWhenDisabled
                      stopPropagation
                      selected={selectedIds.has(retro.id)}
                      onToggle={() => toggleOneRetro(retro.id)}
                      ariaLabel={`振り返り (${retro.conductedDate}) を一括編集対象に追加`}
                    />
                  </TableCell>
                  <TableCell className="font-medium">{retro.conductedDate}</TableCell>
                  <TableCell>
                    <Badge variant={retro.state === 'confirmed' ? 'default' : 'outline'}>
                      {retro.state === 'confirmed' ? tRetro('confirmAction') : tRetro('draftBadge')}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <VisibilityBadge
                      visibility={retro.visibility}
                      label={VISIBILITIES[retro.visibility as keyof typeof VISIBILITIES] || retro.visibility}
                      className="text-xs"
                    />
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">{retro.createdBy}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{formatDate(retro.createdAt)}</TableCell>
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <AttachmentsCell items={attachmentsByEntity[retro.id] ?? []} />
                  </TableCell>
                  {filteredRetros.some((x) => x.createdBy === currentUserId || x.assigneeId === currentUserId) && (
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <div className="flex items-center gap-2">
                        {isOwner && retro.state !== 'confirmed' && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={(e) => { e.stopPropagation(); handleConfirm(retro.id); }}
                          >{tRetro('confirmAction')}</Button>
                        )}
                        {isOwner && (
                          <Button
                            variant="outline"
                            size="sm"
                            className="text-destructive"
                            onClick={(e) => { e.stopPropagation(); handleDelete(retro.id); }}
                          >{t('delete')}</Button>
                        )}
                      </div>
                    </TableCell>
                  )}
                </ClickableRow>
              );
            })
          )}
        </TableBody>
      </ResizableTableShell>

      {/* §35 件数表示は table 下部 */}
      <div className="flex justify-end text-xs text-muted-foreground">
        {tCommon('itemCount', { count: filteredRetros.length })}
      </div>

      {/* Phase B 要件 5: 非作成者は readOnly で詳細表示のみ可。
          feat/asset-assignee-expansion (2026-05-26): 担当者にも編集権限を付与するため、
          readOnly 判定は 作成者 OR 担当者 = 編集可 に変更。 */}
      <RetrospectiveEditDialog
        retro={editingRetro}
        members={members}
        currentProjectId={projectId}
        open={editingRetro != null}
        onOpenChange={(v) => { if (!v) setEditingRetro(null); }}
        onSaved={reload}
        readOnly={
          editingRetro != null &&
          editingRetro.createdBy !== currentUserId &&
          editingRetro.assigneeId !== currentUserId
        }
      />
    </div>
  );
}
