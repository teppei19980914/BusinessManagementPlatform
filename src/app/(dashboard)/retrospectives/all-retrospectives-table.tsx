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
 * 設計ルール (PR #165 で再確定):
 *   - **「全○○」 = 参照のみ** (本画面)
 *   - **「○○一覧」 = CRUD + 一括編集** (`/projects/[id]/retrospectives` 等)
 *   PR #162 で誤って本画面に bulk UI を入れていたが、PR #165 で原状回復。
 *
 * 関連: SPECIFICATION.md (全振り返り画面)
 */

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  TableBody, TableCell, TableHeader, TableRow,
} from '@/components/ui/table';
import { RetrospectiveEditDialog } from '@/components/dialogs/retrospective-edit-dialog';
import type { AllRetroDTO } from '@/services/retrospective.service';
import { AdminRetrospectiveDeleteButton } from './admin-delete-button';
import { useFormatters } from '@/lib/use-formatters';
import { matchesAnyKeyword } from '@/lib/text-search';
// Phase E 要件 1〜3 (2026-04-29): 共通行クリック + フィルタバー部品
import { ClickableRow } from '@/components/common/clickable-row';
import { FilterBar } from '@/components/common/filter-bar';
import { useBatchAttachments } from '@/components/attachments/use-batch-attachments';
import { AttachmentsCell } from '@/components/attachments/attachments-cell';
import { ResizableHead } from '@/components/ui/resizable-columns';
import { ResizableTableShell } from '@/components/common/resizable-table-shell';
import { SortableResizableHead } from '@/components/sort/sortable-resizable-head';
import { useMultiSort } from '@/components/sort/use-multi-sort';
import { multiSort } from '@/lib/multi-sort';
import { useAutoOpenDialog } from '@/components/common/use-auto-open-dialog';
import { useListSearchParams } from '@/components/common/use-list-search-params';

function getRetroSortValue(r: AllRetroDTO, columnKey: string): unknown {
  switch (columnKey) {
    case 'project': return r.projectName ?? '';
    case 'conductedDate': return r.conductedDate;
    case 'planSummary': return r.planSummary;
    case 'actualSummary': return r.actualSummary;
    case 'goodPoints': return r.goodPoints;
    case 'improvements': return r.improvements;
    case 'createdAt': return r.createdAt;
    case 'createdBy': return r.createdByName ?? '';
    case 'updatedAt': return r.updatedAt;
    case 'updatedBy': return r.updatedByName ?? '';
    default: return null;
  }
}

export function AllRetrospectivesTable({
  retros,
  isAdmin,
  initialKeyword = '',
}: {
  retros: AllRetroDTO[];
  isAdmin: boolean;
  /** PR #425 (2026-05-22) KDD §5.X+102: URL ?keyword= 復元用 */
  initialKeyword?: string;
}) {
  const router = useRouter();
  const tRetro = useTranslations('retro');
  const tCommon = useTranslations('common');
  const { formatDateTime, formatDateOnly } = useFormatters();
  const [editingRetro, setEditingRetro] = useState<AllRetroDTO | null>(null);

  // PR-δ / 項目 12: 全振り返りに検索 (keyword) フィルタを追加。
  // PR #425 (2026-05-22) KDD §5.X+102: URL 同期に書き換え (= リロード時に検索条件復元)。
  const { keyword, setKeyword } = useListSearchParams({ initialKeyword });

  // PR feat/sortable-columns (2026-05-01): カラムソート (sessionStorage 永続化、複数列対応)
  const { sortState, setSortColumn } = useMultiSort('sort:all-retrospectives');

  const filteredRetros = useMemo(() => {
    let xs = retros;
    if (keyword.trim()) {
      // Phase C 要件 19 (2026-04-28): 空白区切りで OR 検索
      xs = xs.filter((r) =>
        matchesAnyKeyword(keyword, [
          r.planSummary,
          r.actualSummary,
          r.goodPoints,
          r.improvements,
        ]),
      );
    }
    return multiSort(xs, sortState, getRetroSortValue);
  }, [retros, keyword, sortState]);

  const attachmentsByEntity = useBatchAttachments(
    'retrospective',
    filteredRetros.map((r) => r.id),
  );

  // PR feat/notification-edit-dialog: mention 通知 link `?retroId=...` から auto-open。
  useAutoOpenDialog<AllRetroDTO>({
    queryKey: 'retroId',
    items: retros,
    onOpen: (r) => setEditingRetro(r),
  });

  return (
    <div className="space-y-6">
      {/* feat/all-list-section-unification (2026-05-24): 全○○ 5 画面共通レイアウト規約
          1. 件数行 (justify-end / フィルタ後件数 / common.itemCount)
          2. FilterBar (検索・フィルタ、軸数は画面固有)
          3. ResizableTableShell (テーブル本体)
          4. 詳細ダイアログ (read-only) */}
      <div className="flex justify-end">
        <span className="text-sm text-muted-foreground">{tCommon('itemCount', { count: filteredRetros.length })}</span>
      </div>
      {/* PR-δ / 項目 12: 検索フィルタ (○○一覧と同 UX に揃える) */}
      <FilterBar>
        <div>
          <Label htmlFor="all-retrospectives-filter-keyword" className="text-xs">{tRetro('keyword')}</Label>
          <Input
            id="all-retrospectives-filter-keyword"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder={tRetro('keywordPlaceholder')}
            data-testid="all-retrospectives-search-input"
          />
        </div>
      </FilterBar>
      <ResizableTableShell tableKey="all-retrospectives">
        <TableHeader>
          <TableRow>
            <SortableResizableHead columnKey="project" defaultWidth={140} label={tRetro('project')} sortState={sortState} onSortChange={setSortColumn} />
            <SortableResizableHead columnKey="conductedDate" defaultWidth={110} label={tRetro('conductedDate')} sortState={sortState} onSortChange={setSortColumn} />
            <SortableResizableHead columnKey="planSummary" defaultWidth={180} label={tRetro('planSummary')} sortState={sortState} onSortChange={setSortColumn} />
            <SortableResizableHead columnKey="actualSummary" defaultWidth={180} label={tRetro('actualSummary')} sortState={sortState} onSortChange={setSortColumn} />
            <SortableResizableHead columnKey="goodPoints" defaultWidth={180} label={tRetro('goodPoints')} sortState={sortState} onSortChange={setSortColumn} />
            <SortableResizableHead columnKey="improvements" defaultWidth={180} label={tRetro('improvementsTable')} sortState={sortState} onSortChange={setSortColumn} />
            <SortableResizableHead columnKey="createdAt" defaultWidth={130} label={tRetro('createdAt')} sortState={sortState} onSortChange={setSortColumn} />
            <SortableResizableHead columnKey="createdBy" defaultWidth={120} label={tRetro('createdBy')} sortState={sortState} onSortChange={setSortColumn} />
            <SortableResizableHead columnKey="updatedAt" defaultWidth={130} label={tRetro('updatedAt')} sortState={sortState} onSortChange={setSortColumn} />
            <SortableResizableHead columnKey="updatedBy" defaultWidth={120} label={tRetro('updatedBy')} sortState={sortState} onSortChange={setSortColumn} />
            <ResizableHead columnKey="attachments" defaultWidth={200}>{tRetro('attachment')}</ResizableHead>
            {isAdmin && <ResizableHead columnKey="actions" defaultWidth={80}>{tRetro('actions')}</ResizableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {filteredRetros.map((r) => (
            <ClickableRow
              key={r.id}
              onClick={() => setEditingRetro(r)}
            >
              <TableCell className="text-sm" onClick={(e) => e.stopPropagation()}>
                <div className="flex items-center gap-1.5">
                  {r.projectName == null ? (
                    <span className="text-muted-foreground">{tRetro('private')}</span>
                  ) : r.canAccessProject && r.projectId ? (
                    <Link href={`/projects/${r.projectId}`} className="text-info hover:underline">
                      {r.projectName}
                    </Link>
                  ) : (
                    <span className="text-muted-foreground">
                      {r.projectName}
                      {r.projectDeleted && <span className="ml-1 text-xs text-destructive">{tRetro('deleted')}</span>}
                    </span>
                  )}
                  {/* PR feat/asset-multi-linking-ui (Phase 2): 紐付け先複数の場合の件数 badge */}
                  {r.linkedProjectIds.length > 1 && (
                    <Badge
                      variant="outline"
                      className="text-[10px]"
                      title={`${r.linkedProjectIds.length} 件のプロジェクトに紐付け済`}
                    >
                      +{r.linkedProjectIds.length - 1}
                    </Badge>
                  )}
                </div>
              </TableCell>
              <TableCell className="whitespace-nowrap font-medium">{formatDateOnly(r.conductedDate)}</TableCell>
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
                  {/* feat/crud-permission-redesign (2026-05-20): 横断 DELETE 専用ルートに変更。
                      projectId fallback は不要 (orphan も削除可能になった) */}
                  <AdminRetrospectiveDeleteButton
                    retroId={r.id}
                    label={formatDateOnly(r.conductedDate)}
                  />
                </TableCell>
              )}
            </ClickableRow>
          ))}
          {filteredRetros.length === 0 && (
            <TableRow>
              <TableCell colSpan={isAdmin ? 12 : 11} className="py-8 text-center text-muted-foreground">
                {tRetro('noneInList')}
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </ResizableTableShell>

      <RetrospectiveEditDialog
        retro={editingRetro}
        open={editingRetro != null}
        onOpenChange={(v) => { if (!v) setEditingRetro(null); }}
        onSaved={async () => { router.refresh(); }}
        // 2026-04-24 + PR #165: 全振り返りは編集不可 (読み取り専用)。編集は ○○一覧 経由。
        readOnly={true}
      />
    </div>
  );
}
