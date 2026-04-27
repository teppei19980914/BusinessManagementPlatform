'use client';

/**
 * 全振り返り画面 (横断表示) のテーブルコンポーネント。
 *
 * 役割:
 *   全プロジェクト横断で visibility='public' の振り返りを一覧表示する。
 *   PMO や次担当者が「過去案件で何が起きたか」を一覧で確認できるナレッジ資産ビュー。
 *
 * 行クリック動作:
 *   常に **read-only ダイアログ** で詳細を開く (編集はプロジェクト個別画面経由)。
 *
 * PR #162 (Phase 2) 追加:
 *   - フィルター UI (キーワード / 自分作成のみ) と一括 visibility 編集を CrossListBulkVisibilityToolbar 経由で提供
 *   - フィルター適用時のみ checkbox 列を表示し、viewerIsCreator=true の行のみ編集可
 *
 * 関連: SPECIFICATION.md (全振り返り画面)、DEVELOPER_GUIDE §5.21
 */

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  Table, TableBody, TableCell, TableHeader, TableRow,
} from '@/components/ui/table';
import { RetrospectiveEditDialog } from '@/components/dialogs/retrospective-edit-dialog';
import type { AllRetroDTO } from '@/services/retrospective.service';
import { AdminRetrospectiveDeleteButton } from './admin-delete-button';
import { useFormatters } from '@/lib/use-formatters';
import { useBatchAttachments } from '@/components/attachments/use-batch-attachments';
import { AttachmentsCell } from '@/components/attachments/attachments-cell';
import {
  ResizableColumnsProvider,
  ResizableHead,
  ResetColumnsButton,
} from '@/components/ui/resizable-columns';
import {
  CrossListBulkVisibilityToolbar,
  EMPTY_FILTER,
  isCrossListFilterActive,
  type CrossListFilterState,
} from '@/components/cross-list-bulk-visibility-toolbar';

const VISIBILITY_OPTIONS = [
  { value: 'draft', label: '下書き (公開取り下げ)' },
  { value: 'public', label: '公開' },
];

export function AllRetrospectivesTable({
  retros,
  isAdmin,
}: {
  retros: AllRetroDTO[];
  isAdmin: boolean;
}) {
  const router = useRouter();
  const { formatDateTime } = useFormatters();
  const [editingRetro, setEditingRetro] = useState<AllRetroDTO | null>(null);

  // PR #162: フィルター + 一括選択
  const [filter, setFilter] = useState<CrossListFilterState>(EMPTY_FILTER);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const filterApplied = isCrossListFilterActive(filter);

  const filteredRetros = useMemo(() => {
    let xs = retros;
    if (filter.mineOnly) xs = xs.filter((r) => r.viewerIsCreator);
    if (filter.keyword.trim()) {
      const kw = filter.keyword.trim().toLowerCase();
      xs = xs.filter((r) =>
        (r.planSummary ?? '').toLowerCase().includes(kw)
        || (r.actualSummary ?? '').toLowerCase().includes(kw)
        || (r.goodPoints ?? '').toLowerCase().includes(kw)
        || (r.improvements ?? '').toLowerCase().includes(kw),
      );
    }
    return xs;
  }, [retros, filter]);

  const attachmentsByEntity = useBatchAttachments(
    'retrospective',
    filteredRetros.map((r) => r.id),
  );

  const selectableIds = filterApplied
    ? filteredRetros.filter((r) => r.viewerIsCreator).map((r) => r.id)
    : [];
  const allSelectableSelected
    = selectableIds.length > 0 && selectableIds.every((id) => selectedIds.has(id));

  function toggleOne(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelectedIds(allSelectableSelected ? new Set() : new Set(selectableIds));
  }

  return (
    <ResizableColumnsProvider tableKey="all-retrospectives">
      <CrossListBulkVisibilityToolbar
        endpointPath="retrospectives"
        filter={filter}
        onFilterChange={setFilter}
        selectedIds={selectedIds}
        onSelectionClear={() => setSelectedIds(new Set())}
        visibilityOptions={VISIBILITY_OPTIONS}
        entityLabel="振り返り"
        onApplied={async () => { router.refresh(); }}
      />

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
                  onChange={toggleAll}
                  className="rounded"
                />
              </ResizableHead>
            )}
            <ResizableHead columnKey="project" defaultWidth={140}>プロジェクト</ResizableHead>
            <ResizableHead columnKey="conductedDate" defaultWidth={110}>実施日</ResizableHead>
            <ResizableHead columnKey="planSummary" defaultWidth={180}>計画総括</ResizableHead>
            <ResizableHead columnKey="actualSummary" defaultWidth={180}>実績総括</ResizableHead>
            <ResizableHead columnKey="goodPoints" defaultWidth={180}>良かった点</ResizableHead>
            <ResizableHead columnKey="improvements" defaultWidth={180}>次回以前事項</ResizableHead>
            <ResizableHead columnKey="createdAt" defaultWidth={130}>作成日時</ResizableHead>
            <ResizableHead columnKey="createdBy" defaultWidth={120}>作成者</ResizableHead>
            <ResizableHead columnKey="updatedAt" defaultWidth={130}>更新日時</ResizableHead>
            <ResizableHead columnKey="updatedBy" defaultWidth={120}>更新者</ResizableHead>
            <ResizableHead columnKey="attachments" defaultWidth={200}>添付</ResizableHead>
            {isAdmin && <ResizableHead columnKey="actions" defaultWidth={80}>操作</ResizableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {filteredRetros.map((r) => (
            <TableRow
              key={r.id}
              className="cursor-pointer hover:bg-muted"
              onClick={() => setEditingRetro(r)}
            >
              {filterApplied && (
                <TableCell onClick={(e) => e.stopPropagation()}>
                  {r.viewerIsCreator ? (
                    <input
                      type="checkbox"
                      aria-label={`${r.conductedDate} を一括編集対象に追加`}
                      checked={selectedIds.has(r.id)}
                      onChange={() => toggleOne(r.id)}
                      className="rounded"
                    />
                  ) : (
                    <span className="text-xs text-muted-foreground" title="自分が作成したものではないため一括編集できません">-</span>
                  )}
                </TableCell>
              )}
              <TableCell className="text-sm" onClick={(e) => e.stopPropagation()}>
                {r.projectName == null ? (
                  <span className="text-muted-foreground">（非公開）</span>
                ) : r.canAccessProject ? (
                  <Link href={`/projects/${r.projectId}`} className="text-info hover:underline">
                    {r.projectName}
                  </Link>
                ) : (
                  <span className="text-muted-foreground">
                    {r.projectName}
                    {r.projectDeleted && <span className="ml-1 text-xs text-destructive">(削除済)</span>}
                  </span>
                )}
              </TableCell>
              <TableCell className="whitespace-nowrap font-medium">{r.conductedDate}</TableCell>
              <TableCell className="max-w-xs truncate text-sm">{r.planSummary || '-'}</TableCell>
              <TableCell className="max-w-xs truncate text-sm">{r.actualSummary || '-'}</TableCell>
              <TableCell className="max-w-xs truncate text-sm">{r.goodPoints || '-'}</TableCell>
              <TableCell className="max-w-xs truncate text-sm">{r.improvements || '-'}</TableCell>
              <TableCell className="whitespace-nowrap text-sm text-muted-foreground">{formatDateTime(r.createdAt)}</TableCell>
              <TableCell className="text-sm text-muted-foreground">
                {r.createdByName ?? <span className="text-muted-foreground">-</span>}
              </TableCell>
              <TableCell className="whitespace-nowrap text-sm text-muted-foreground">{formatDateTime(r.updatedAt)}</TableCell>
              <TableCell className="text-sm text-muted-foreground">
                {r.updatedByName ?? <span className="text-muted-foreground">-</span>}
              </TableCell>
              <TableCell onClick={(e) => e.stopPropagation()}>
                <AttachmentsCell items={attachmentsByEntity[r.id] ?? []} />
              </TableCell>
              {isAdmin && (
                <TableCell onClick={(e) => e.stopPropagation()}>
                  <AdminRetrospectiveDeleteButton
                    projectId={r.projectId}
                    retroId={r.id}
                    label={r.conductedDate}
                  />
                </TableCell>
              )}
            </TableRow>
          ))}
          {filteredRetros.length === 0 && (
            <TableRow>
              <TableCell
                colSpan={(isAdmin ? 12 : 11) + (filterApplied ? 1 : 0)}
                className="py-8 text-center text-muted-foreground"
              >
                振り返りがありません
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>

      <RetrospectiveEditDialog
        retro={editingRetro}
        open={editingRetro != null}
        onOpenChange={(v) => { if (!v) setEditingRetro(null); }}
        onSaved={async () => { router.refresh(); }}
        readOnly={true}
      />
    </ResizableColumnsProvider>
  );
}
