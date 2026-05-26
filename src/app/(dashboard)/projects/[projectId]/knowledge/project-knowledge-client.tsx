'use client';

/**
 * プロジェクト別ナレッジ画面 (詳細タブ配下) のクライアントコンポーネント。
 *
 * 役割:
 *   このプロジェクトに紐付いたナレッジの一覧 / 追加 / 編集 / 解除を管理する。
 *   knowledge_projects テーブル経由の N:M 紐付けで、1 ナレッジは複数プロジェクトに
 *   共有可能。
 *
 * 紐付け解除と削除の差:
 *   - 解除: knowledge_projects から該当行のみ削除。ナレッジ本体は残る (他プロジェクトで参照可)
 *   - 削除: ナレッジ本体を deletedAt 設定 (作成者本人 or admin のみ)
 *
 * 認可: canEdit prop (PM/TL 以上 or admin)。
 * API: /api/projects/[id]/knowledge (GET/POST), /api/projects/[id]/knowledge/[knowledgeId] (DELETE for unlink)
 *
 * 関連: SPECIFICATION.md (プロジェクト別ナレッジ管理)
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useLoading } from '@/components/loading-overlay';
import { useToast } from '@/components/toast-provider';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { nativeSelectClass } from '@/components/ui/native-select-style';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';
import { Trash2 } from 'lucide-react';
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
import { KnowledgeEditDialog } from '@/components/dialogs/knowledge-edit-dialog';
import { EntitySyncImportDialog } from '@/components/dialogs/entity-sync-import-dialog';
// fix/project-create-customer-validation: 重複定義を集約、全角読点 (、) 対応追加
import {
  StagedAttachmentsInput,
  persistStagedAttachments,
  type StagedAttachment,
} from '@/components/attachments/staged-attachments-input';
import { KNOWLEDGE_TYPES, VISIBILITIES } from '@/types';
import type { KnowledgeDTO } from '@/services/knowledge.service';
// feat/asset-assignee-expansion (2026-05-26): 担当者 selector 用 member DTO
import type { MemberDTO } from '@/services/member.service';
// PR #168: 一覧画面に添付列を表示 (横展開)
import { useBatchAttachments } from '@/components/attachments/use-batch-attachments';
import { AttachmentsCell } from '@/components/attachments/attachments-cell';
// feat/dialog-fullscreen-toggle: 文字量が多い dialog 向けの全画面トグル
import { useDialogFullscreen } from '@/components/ui/use-dialog-fullscreen';
// feat/markdown-textarea: Markdown 入力 + プレビュー (create dialog のため previousValue なし)
import { MarkdownTextarea } from '@/components/ui/markdown-textarea';
// PR #165: project-level「ナレッジ一覧」での一括 visibility 変更 (cross-list /knowledge から移し替え)
import {
  CrossListBulkVisibilityToolbar,
  EMPTY_FILTER,
  type CrossListFilterState,
} from '@/components/cross-list-bulk-visibility-toolbar';

// NOTE: i18n labels are resolved inside the component (translations require a hook context).
function buildKnowledgeVisibilityOptions(t: (key: string) => string) {
  return [
    { value: 'draft', label: t('visibilityDraftLabel') },
    { value: 'public', label: t('visibilityPublicLabel') },
  ];
}

// UI_PATTERNS §35 (2026-05-24): 軽量テーブル化に伴うカラムソート getter。multiSort の比較に使う。
function getProjectKnowledgeSortValue(k: KnowledgeDTO, columnKey: string): unknown {
  switch (columnKey) {
    case 'title': return k.title;
    case 'type': return k.knowledgeType;
    case 'visibility': return k.visibility;
    case 'createdBy': return k.creatorName ?? '';
    case 'updatedAt': return k.updatedAt;
    default: return null;
  }
}

type Props = {
  projectId: string;
  knowledges: KnowledgeDTO[];
  /** feat/asset-assignee-expansion (2026-05-26): 担当者 selector の選択肢 (任意) */
  members?: MemberDTO[];
  /** 2026-04-24: 作成ボタンの表示可否 (実際の ProjectMember の pm_tl/member のみ true) */
  canCreate: boolean;
  /** 2026-04-24: 作成者本人判定 (k.createdBy === currentUserId で編集/削除許可) */
  currentUserId: string;
  onReload: () => Promise<void> | void;
};


/**
 * プロジェクト詳細「ナレッジ一覧」タブのクライアントコンポーネント。
 *
 * 役割:
 *   - そのプロジェクトに紐づくナレッジのみ表示 (プロジェクト scoped)
 *   - 作成: /api/projects/[projectId]/knowledge (自動で projectId に紐付け)
 *   - 削除: /api/projects/[projectId]/knowledge/[knowledgeId] (ProjectMember 認可)
 *   - 「全ナレッジ」画面と同一テーブル参照のため、ここでの CRUD は即座に
 *     /knowledge ビューにも反映される
 */
export function ProjectKnowledgeClient({
  projectId,
  knowledges,
  members,
  canCreate,
  currentUserId,
  onReload,
}: Props) {
  const tKnowledge = useTranslations('knowledge');
  const tCommon = useTranslations('common');
  const KNOWLEDGE_VISIBILITY_OPTIONS = buildKnowledgeVisibilityOptions(tKnowledge);
  const { withLoading } = useLoading();
  const { showSuccess, showError } = useToast();
  const { formatDate } = useFormatters();
  // UI_PATTERNS §35: カラムソート (sessionStorage 永続化、複数列対応)
  const { sortState, setSortColumn } = useMultiSort(`sort:project-knowledge-${projectId}`);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  // T-22 Phase 22c: 上書きインポート (sync-import) ダイアログ
  const [isSyncImportOpen, setIsSyncImportOpen] = useState(false);
  const [error, setError] = useState('');
  // Req 8: 行クリックで編集ダイアログ
  const [editingKnowledge, setEditingKnowledge] = useState<KnowledgeDTO | null>(null);
  // feat/dialog-fullscreen-toggle: ナレッジ作成 dialog の全画面トグル
  const { fullscreenClassName: createFsClassName, FullscreenToggle: CreateFullscreenToggle } = useDialogFullscreen();

  // PR #165 + Phase C 要件 18 (2026-04-28): 一括 visibility 変更。
  // フィルター必須要件は撤廃し、checkbox 列とツールバーは常時表示。
  const [bulkFilter, setBulkFilter] = useState<CrossListFilterState>(EMPTY_FILTER);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const filteredKnowledges = (() => {
    let xs = knowledges;
    if (bulkFilter.mineOnly) xs = xs.filter((k) => k.createdBy === currentUserId);
    if (bulkFilter.keyword.trim()) {
      // Phase C 要件 19 (2026-04-28): 空白区切りで OR 検索
      xs = xs.filter((k) =>
        matchesAnyKeyword(bulkFilter.keyword, [k.title, k.background, k.content, k.result]),
      );
    }
    // UI_PATTERNS §35: 軽量テーブル化に伴い multi-sort 適用
    return multiSort(xs, sortState, getProjectKnowledgeSortValue);
  })();

  // feat/asset-assignee-expansion (2026-05-26): 作成者 OR 担当者を編集可能 (= bulk 対象)
  const selectableKnowledgeIds = filteredKnowledges
    .filter((k) => k.createdBy === currentUserId || k.assigneeId === currentUserId)
    .map((k) => k.id);
  const allKnowledgeSelected
    = selectableKnowledgeIds.length > 0 && selectableKnowledgeIds.every((id) => selectedIds.has(id));

  // PR #168: 添付バッチ取得 (他エンティティ一覧と同パターン)
  const attachmentsByEntity = useBatchAttachments('knowledge', filteredKnowledges.map((k) => k.id));

  function toggleOneKnowledge(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleAllKnowledge() {
    setSelectedIds(allKnowledgeSelected ? new Set() : new Set(selectableKnowledgeIds));
  }

  // refactor/knowledge-tags-removal-temp (2026-04-27): 3 タグ入力 UI を一時撤去。
  // 本格的な提案エンジン改修は 2026-05 で実施予定。それまでは空配列で送信し、
  // 既存ナレッジの既存タグは温存する (DB 側のフィールドは残置)。
  const initialForm = {
    title: '',
    knowledgeType: 'research',
    background: '',
    content: '',
    result: '',
    visibility: 'draft',
  };
  const [form, setForm] = useState(initialForm);

  // PR #67: ナレッジ作成時にステージする添付 URL (general slot)
  const [stagedCreateAttachments, setStagedCreateAttachments] = useState<StagedAttachment[]>([]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError('');

    const payload = {
      title: form.title,
      knowledgeType: form.knowledgeType,
      background: form.background,
      content: form.content,
      result: form.result,
      visibility: form.visibility,
      // refactor/knowledge-tags-removal-temp: タグ入力を撤去したため空配列を送信
      businessDomainTags: [],
      techTags: [],
      processTags: [],
    };

    const res = await withLoading(() =>
      fetch(`/api/projects/${projectId}/knowledge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }),
    );

    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      const msg = json.error?.message || json.error?.details?.[0]?.message || tKnowledge('createFailed');
      setError(msg);
      showError('ナレッジの作成に失敗しました');
      return;
    }

    // PR #67: 作成成功直後にステージされた添付を一括 POST
    const json = await res.json();
    if (stagedCreateAttachments.length > 0 && json.data?.id) {
      await persistStagedAttachments({
        entityType: 'knowledge',
        entityId: json.data.id,
        items: stagedCreateAttachments,
      });
    }
    setStagedCreateAttachments([]);

    setIsCreateOpen(false);
    setForm(initialForm);
    showSuccess('ナレッジを作成しました');
    await onReload();
  }

  async function handleDelete(knowledgeId: string) {
    if (!confirm(tKnowledge('deleteConfirm'))) return;
    const res = await withLoading(() =>
      fetch(`/api/projects/${projectId}/knowledge/${knowledgeId}`, { method: 'DELETE' }),
    );
    if (!res.ok) {
      showError('ナレッジの削除に失敗しました');
      return;
    }
    showSuccess('ナレッジを削除しました');
    await onReload();
  }

  return (
    <div className="space-y-4">
      {/* PR #165: project-level「ナレッジ一覧」での一括 visibility 変更 */}
      <CrossListBulkVisibilityToolbar
        endpoint={`/api/projects/${projectId}/knowledge/bulk`}
        formIdPrefix={`project-knowledge-${projectId}`}
        filter={bulkFilter}
        onFilterChange={setBulkFilter}
        selectedIds={selectedIds}
        onSelectionClear={() => setSelectedIds(new Set())}
        visibilityOptions={KNOWLEDGE_VISIBILITY_OPTIONS}
        entityLabel={tKnowledge('title')}
        onApplied={async () => { await onReload(); }}
      />

      {/* PR fix/list-export-and-filter (2026-05-01): 他「○○一覧」(risks / retrospectives 等)
          と UI を揃えるため、justify-end (ボタン右寄せのみ) + size 既定 (sm 不使用) に統一。
          件数表示は他一覧では出していないため本行から削除。 */}
      <div className="flex items-center justify-end">
        <div className="flex gap-2">
        {/* T-22 Phase 22c: sync-import (往復編集) */}
        {canCreate && (
          <>
            <Button variant="outline" onClick={() => window.open(`/api/projects/${projectId}/knowledge/export?mode=sync`, '_blank')}>
              {tKnowledge('syncExport')}
            </Button>
            <Button variant="outline" onClick={() => setIsSyncImportOpen(true)}>
              {tKnowledge('syncImportButton')}
            </Button>
          </>
        )}
        {canCreate && (
          <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
            {/* PR #124: 他「○○一覧」(risks / retrospectives) と同サイズ (px-4 py-2) に統一 */}
            <DialogTrigger className="inline-flex shrink-0 items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-xs hover:bg-primary/90">{tKnowledge('createTitle')}</DialogTrigger>
              <DialogContent className={`max-w-[min(90vw,36rem)] max-h-[80vh] overflow-y-auto ${createFsClassName}`}>
                <DialogHeader>
                  <div className="flex items-center justify-between gap-2">
                    <DialogTitle>{tKnowledge('createTitle')}</DialogTitle>
                    <CreateFullscreenToggle />
                  </div>
                  <DialogDescription>
                    {tKnowledge('createDescription')}
                  </DialogDescription>
                </DialogHeader>
                <form onSubmit={handleCreate} className="space-y-4">
                  {error && (
                    <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>
                  )}
                  <div className="space-y-2">
                    <Label>
                      {tKnowledge('fieldTitle')}
                      {/* 2026-05-11: 公開範囲 = 自分のみ (draft) なら任意、全メンバー (public) なら必須 */}
                      {form.visibility === 'draft' && (
                        <span className="ml-2 text-xs text-muted-foreground">(任意)</span>
                      )}
                    </Label>
                    <Input
                      value={form.title}
                      onChange={(e) => setForm({ ...form, title: e.target.value })}
                      maxLength={150}
                      required={form.visibility === 'public'}
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label>{tKnowledge('kind')}</Label>
                      <select
                        value={form.knowledgeType}
                        onChange={(e) => setForm({ ...form, knowledgeType: e.target.value })}
                        className={nativeSelectClass}
                      >
                        {Object.entries(KNOWLEDGE_TYPES).map(([key, label]) => (
                          <option key={key} value={key}>{label}</option>
                        ))}
                      </select>
                    </div>
                    <div className="space-y-2">
                      <Label>{tKnowledge('visibility')}</Label>
                      <select
                        value={form.visibility}
                        onChange={(e) => setForm({ ...form, visibility: e.target.value })}
                        className={nativeSelectClass}
                      >
                        {Object.entries(VISIBILITIES).map(([key, label]) => (
                          <option key={key} value={key}>{label}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                  {/* refactor/list-create-content-optional (2026-04-27 #6): タイトル必須、3 セクションは任意 */}
                  <div className="space-y-2">
                    <Label>{tKnowledge('background')} <span className="text-xs text-muted-foreground">{tKnowledge('optional')}</span></Label>
                    <MarkdownTextarea
                      value={form.background}
                      onChange={(v) => setForm({ ...form, background: v })}
                      rows={3}
                      maxLength={2000}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>{tKnowledge('content')} <span className="text-xs text-muted-foreground">{tKnowledge('optional')}</span></Label>
                    <MarkdownTextarea
                      value={form.content}
                      onChange={(v) => setForm({ ...form, content: v })}
                      rows={5}
                      maxLength={5000}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>{tKnowledge('result')} <span className="text-xs text-muted-foreground">{tKnowledge('optional')}</span></Label>
                    <MarkdownTextarea
                      value={form.result}
                      onChange={(v) => setForm({ ...form, result: v })}
                      rows={3}
                      maxLength={3000}
                    />
                  </div>
                  {/*
                    refactor/knowledge-tags-removal-temp (2026-04-27 ユーザ要望 #3):
                    業務ドメインタグ / 技術スタックタグ / 工程タグの 3 入力を一時撤去。
                    本格的な提案エンジン改修は 2026-05 に実施予定 (memory: project_suggestion_engine_priority)。
                    DB 列 (knowledges.business_domain_tags / tech_tags / process_tags) と
                    service 層 (parseTagsInput) は据置で温存し、UI のみ削除する暫定措置。
                    既存ナレッジの既存タグはそのまま読み取り可、新規作成時は空配列で保存される。
                  */}
                  {/* PR #67: 作成と同時に参考リンク等の URL を登録可能 */}
                  <StagedAttachmentsInput
                    value={stagedCreateAttachments}
                    onChange={setStagedCreateAttachments}
                    label={tKnowledge('referenceLinks')}
                  />
                  <Button type="submit" className="w-full">{tKnowledge('create')}</Button>
                </form>
              </DialogContent>
            </Dialog>
          )}
        </div>
      </div>

      {/* T-22 Phase 22c: 上書きインポート (sync-import) ダイアログ */}
      <EntitySyncImportDialog
        apiBasePath={`/api/projects/${projectId}/knowledge/sync-import`}
        i18nNamespace="knowledge.syncImport"
        open={isSyncImportOpen}
        onOpenChange={setIsSyncImportOpen}
        onImported={async () => { await onReload(); }}
      />

      {/* UI_PATTERNS §35 (2026-05-24): 軽量テーブル統一。詳細 (background / content / result) は
          行クリックで KnowledgeEditDialog (readOnly 判定付き) を開いて表示する。 */}
      <ResizableTableShell tableKey={`project-knowledge-${projectId}`}>
        <TableHeader>
          <TableRow>
            <ResizableHead columnKey="select" defaultWidth={36}>
              <BulkSelectHeader
                allSelected={allKnowledgeSelected}
                totalSelectable={selectableKnowledgeIds.length}
                onToggleAll={toggleAllKnowledge}
                ariaLabel={tKnowledge('selectAllOwn')}
              />
            </ResizableHead>
            <SortableResizableHead columnKey="title" defaultWidth={240} label={tKnowledge('fieldTitle')} sortState={sortState} onSortChange={setSortColumn} />
            <SortableResizableHead columnKey="type" defaultWidth={100} label={tKnowledge('kind')} sortState={sortState} onSortChange={setSortColumn} />
            <SortableResizableHead columnKey="visibility" defaultWidth={90} label={tKnowledge('visibility')} sortState={sortState} onSortChange={setSortColumn} />
            <SortableResizableHead columnKey="createdBy" defaultWidth={120} label={tKnowledge('createdBy')} sortState={sortState} onSortChange={setSortColumn} />
            <SortableResizableHead columnKey="updatedAt" defaultWidth={130} label={tKnowledge('updatedAt')} sortState={sortState} onSortChange={setSortColumn} />
            <ResizableHead columnKey="attachments" defaultWidth={180}>{tKnowledge('attachment')}</ResizableHead>
            {/* 2026-04-24 / §35: 作成者本人だけが削除ボタンを使うので、自分の行が 1 つでもあれば列を出す。
                feat/asset-assignee-expansion (2026-05-26): 担当者も削除可能なので OR で拡張。 */}
            {filteredKnowledges.some((k) => k.createdBy === currentUserId || k.assigneeId === currentUserId) && (
              <ResizableHead columnKey="actions" defaultWidth={64}>{tKnowledge('actions')}</ResizableHead>
            )}
          </TableRow>
        </TableHeader>
        <TableBody>
          {filteredKnowledges.length === 0 ? (
            <TableRow>
              <TableCell
                colSpan={filteredKnowledges.some((k) => k.createdBy === currentUserId || k.assigneeId === currentUserId) ? 8 : 7}
                className="py-8 text-center text-muted-foreground"
              >
                {tKnowledge('noneInList')}
              </TableCell>
            </TableRow>
          ) : (
            filteredKnowledges.map((k) => {
              // feat/asset-assignee-expansion (2026-05-26): 作成者 OR 担当者を編集可能
              const isOwner = k.createdBy === currentUserId || k.assigneeId === currentUserId;
              return (
                <ClickableRow key={k.id} onClick={() => setEditingKnowledge(k)}>
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <BulkSelectCell
                      canSelect={isOwner}
                      hidePlaceholderWhenDisabled
                      stopPropagation
                      selected={selectedIds.has(k.id)}
                      onToggle={() => toggleOneKnowledge(k.id)}
                      ariaLabel={tKnowledge('addToBulkEdit', { title: k.title })}
                    />
                  </TableCell>
                  <TableCell className="font-medium">{k.title}</TableCell>
                  <TableCell>
                    <Badge variant="secondary" className="text-xs">
                      {KNOWLEDGE_TYPES[k.knowledgeType as keyof typeof KNOWLEDGE_TYPES] || k.knowledgeType}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <VisibilityBadge
                      visibility={k.visibility}
                      label={VISIBILITIES[k.visibility as keyof typeof VISIBILITIES] || k.visibility}
                      className="text-xs"
                    />
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">{k.creatorName ?? ''}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{formatDate(k.updatedAt)}</TableCell>
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <AttachmentsCell items={attachmentsByEntity[k.id] ?? []} />
                  </TableCell>
                  {filteredKnowledges.some((x) => x.createdBy === currentUserId || x.assigneeId === currentUserId) && (
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      {isOwner && (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          className="text-destructive hover:text-destructive"
                          title={tKnowledge('deleteAria')}
                          aria-label={tKnowledge('deleteAria')}
                          onClick={(e) => { e.stopPropagation(); handleDelete(k.id); }}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      )}
                    </TableCell>
                  )}
                </ClickableRow>
              );
            })
          )}
        </TableBody>
      </ResizableTableShell>

      {/* §35 件数表示は table 下部 (project 配下は table 上部に CRUD ボタン群があるため) */}
      <div className="flex justify-end text-xs text-muted-foreground">
        {tCommon('itemCount', { count: filteredKnowledges.length })}
      </div>

      {/* Phase B 要件 5: 非作成者は readOnly で詳細表示のみ可。
          feat/asset-assignee-expansion (2026-05-26): 担当者にも編集権限を付与するため、
          readOnly 判定は viewerCanEdit ベース (作成者 OR 担当者 = 編集可) に変更。 */}
      <KnowledgeEditDialog
        knowledge={editingKnowledge}
        projectId={projectId}
        members={members}
        open={editingKnowledge != null}
        onOpenChange={(v) => { if (!v) setEditingKnowledge(null); }}
        onSaved={async () => { await onReload(); }}
        readOnly={
          editingKnowledge != null &&
          editingKnowledge.createdBy !== currentUserId &&
          editingKnowledge.assigneeId !== currentUserId
        }
      />
    </div>
  );
}
