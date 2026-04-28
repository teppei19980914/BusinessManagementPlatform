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
import { Button } from '@/components/ui/button';
import { matchesAnyKeyword } from '@/lib/text-search';
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

type Props = {
  projectId: string;
  retros: RetroDTO[];
  /** 2026-04-24: 振り返り作成ボタンの表示可否 (実際の ProjectMember の pm_tl/member のみ true) */
  canCreate: boolean;
  /** 作成者本人判定用 (createdBy === currentUserId で編集/削除許可) */
  currentUserId: string;
  /** CRUD 後に呼び出す再取得ハンドラ（未指定時は router.refresh フォールバック）*/
  onReload?: () => Promise<void> | void;
};

export function RetrospectivesClient({ projectId, retros, canCreate, currentUserId, onReload }: Props) {
  const t = useTranslations('action');
  const tRetro = useTranslations('retro');
  const RETRO_VISIBILITY_OPTIONS = buildRetroVisibilityOptions(tRetro);
  const router = useRouter();
  const { withLoading } = useLoading();
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
    return xs;
  })();

  const selectableRetroIds = filteredRetros
    .filter((r) => r.createdBy === currentUserId)
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
    const res = await withLoading(() =>
      fetch(`/api/projects/${projectId}/retrospectives`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      }),
    );
    if (!res.ok) {
      const json = await res.json();
      setError(json.error?.message || json.error?.details?.[0]?.message || tRetro('createFailed'));
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
    await reload();
  }

  async function handleConfirm(retroId: string) {
    // PR #57 修正: 以前は POST /retrospectives に { action: 'confirm', retroId } を送って
    // 400 (create schema 違反) になっていた。正しい経路である
    // PATCH /retrospectives/[retroId] に state='confirmed' を送る。
    await fetch(`/api/projects/${projectId}/retrospectives/${retroId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: 'confirmed' }),
    });
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
      alert(tRetro('deleteFailed'));
      return;
    }
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
                  <Label>{tRetro('conductedDate')}</Label>
                  <DateFieldWithActions value={form.conductedDate} onChange={(v) => setForm({ ...form, conductedDate: v })} required hideClear />
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

      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <input
          type="checkbox"
          checked={allRetrosSelected}
          disabled={selectableRetroIds.length === 0}
          onChange={toggleAllRetros}
          className="rounded"
          aria-label={tRetro('selectAllOwn')}
        />
        {tRetro('selectAllOwn')} ({selectableRetroIds.length})
      </div>

      {filteredRetros.length === 0 && (
        <p className="py-8 text-center text-muted-foreground">{tRetro('noneInList')}</p>
      )}

      {filteredRetros.map((retro) => {
        // 2026-04-24: 作成者本人のみ編集/確定/削除可
        const isOwner = retro.createdBy === currentUserId;
        return (
        <div
          key={retro.id}
          className="rounded-lg border p-6 space-y-4 cursor-pointer hover:bg-muted/50"
          // Phase B 要件 5 (2026-04-28): カードクリックで dialog を開く動作は全員で active 化。
          //   詳細閲覧目的を含み、編集可否は dialog の readOnly prop で分岐する。
          onClick={() => setEditingRetro(retro)}
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              {isOwner && (
                <input
                  type="checkbox"
                  aria-label={`振り返り (${retro.conductedDate}) を一括編集対象に追加`}
                  checked={selectedIds.has(retro.id)}
                  onChange={(e) => { e.stopPropagation(); toggleOneRetro(retro.id); }}
                  onClick={(e) => e.stopPropagation()}
                  className="rounded"
                />
              )}
              <h3 className="font-semibold">{tRetro('title')}（{retro.conductedDate}）</h3>
              <Badge variant={retro.state === 'confirmed' ? 'default' : 'outline'}>
                {retro.state === 'confirmed' ? tRetro('confirmAction') : tRetro('draftBadge')}
              </Badge>
              {/* feat/account-lock-and-ui-consistency: 公開範囲バッジを追加。
                  編集ダイアログで visibility を変更しても一覧に表示されず「画面上データが
                  更新されていない」ように見える bug の解消。state とは別概念なので
                  「公開: ○○」のラベル付きで明示。 */}
              <Badge variant={retro.visibility === 'public' ? 'default' : 'outline'}>
                公開: {VISIBILITIES[retro.visibility as keyof typeof VISIBILITIES] || retro.visibility}
              </Badge>
            </div>
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
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <h4 className="text-sm font-medium text-muted-foreground">{tRetro('goodPoints')}</h4>
              <p className="mt-1 whitespace-pre-wrap text-sm">{retro.goodPoints}</p>
            </div>
            <div>
              <h4 className="text-sm font-medium text-muted-foreground">{tRetro('problems')}</h4>
              <p className="mt-1 whitespace-pre-wrap text-sm">{retro.problems}</p>
            </div>
            <div className="md:col-span-2">
              <h4 className="text-sm font-medium text-muted-foreground">{tRetro('improvements')}</h4>
              <p className="mt-1 whitespace-pre-wrap text-sm">{retro.improvements}</p>
            </div>
            {/* PR #168: 添付 chips (他エンティティ一覧と同パターン) */}
            <div className="md:col-span-2" onClick={(e) => e.stopPropagation()}>
              <h4 className="mb-1 text-sm font-medium text-muted-foreground">{tRetro('attachment')}</h4>
              <AttachmentsCell items={attachmentsByEntity[retro.id] ?? []} />
            </div>
          </div>

          {/*
            項目 10: 振り返りのコメント機能は現状非表示。
            将来計画: 各「○○一覧」(リスク/課題/振り返り/ナレッジ) で横ぐしのコメント機能を実装し、
            コメント時に通知が飛ぶ仕組みを導入予定 (PR-α 段階では UI 削除のみ、API/DB/service は温存)。
            対応する API: POST /api/projects/[id]/retrospectives/[retroId]/comments は残置。
            DTO の retro.comments は無視 (計算済だが UI で参照しない)。
          */}
        </div>
        );
      })}

      {/* Phase B 要件 5: 非作成者は readOnly で詳細表示のみ可。 */}
      <RetrospectiveEditDialog
        retro={editingRetro}
        open={editingRetro != null}
        onOpenChange={(v) => { if (!v) setEditingRetro(null); }}
        onSaved={reload}
        readOnly={editingRetro != null && editingRetro.createdBy !== currentUserId}
      />
    </div>
  );
}
