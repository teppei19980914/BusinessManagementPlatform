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
import { useTablePagination, TablePagination } from '@/components/common/table-pagination';
import { useBatchAttachments } from '@/components/attachments/use-batch-attachments';
import { AttachmentsCell } from '@/components/attachments/attachments-cell';
// 2026-06-03: ○○一覧と列構成を統一 (リンク列 / 担当者列 / ステータス列、本文列は撤去)。
import { LinksCell } from '@/components/attachments/links-cell';
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
    case 'assigneeName': return r.assigneeName ?? '';
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
  const { formatDateTimeSeconds, formatDateOnly } = useFormatters();
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

  const { pageItems, page, pageCount, setPage } = useTablePagination(filteredRetros, keyword);

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
      {/* 2026-06-03: フィルター位置をプロジェクト一覧に統一。FilterBar を先頭に置き、件数は表の下部へ移動。 */}
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
            {/* 2026-06-03: 振り返り一覧(タブ)と列構成を統一 — プロジェクト + 実施日・ステータス・担当者・監査4・リンク・添付・操作。
                本文列(計画総括/実績総括/良かった点/次回改善事項)は詳細ダイアログでのみ表示するため一覧からは撤去。 */}
            <SortableResizableHead columnKey="project" defaultWidth={140} label={tRetro('project')} sortState={sortState} onSortChange={setSortColumn} />
            <SortableResizableHead columnKey="conductedDate" defaultWidth={110} label={tRetro('conductedDate')} sortState={sortState} onSortChange={setSortColumn} />
            {/* 2026-06-12: 状態(下書き/確定)列を撤去 (プロジェクト別振り返り一覧と統一)。 */}
            <SortableResizableHead columnKey="assigneeName" defaultWidth={120} label={tRetro('assignee')} sortState={sortState} onSortChange={setSortColumn} />
            <SortableResizableHead columnKey="createdBy" defaultWidth={120} label={tRetro('createdBy')} sortState={sortState} onSortChange={setSortColumn} />
            <SortableResizableHead columnKey="createdAt" defaultWidth={150} label={tRetro('createdAt')} sortState={sortState} onSortChange={setSortColumn} />
            <SortableResizableHead columnKey="updatedBy" defaultWidth={120} label={tRetro('updatedBy')} sortState={sortState} onSortChange={setSortColumn} />
            <SortableResizableHead columnKey="updatedAt" defaultWidth={150} label={tRetro('updatedAt')} sortState={sortState} onSortChange={setSortColumn} />
            <ResizableHead columnKey="links" defaultWidth={200}>{tRetro('links')}</ResizableHead>
            <ResizableHead columnKey="attachments" defaultWidth={180}>{tRetro('attachment')}</ResizableHead>
            {isAdmin && <ResizableHead columnKey="actions" defaultWidth={80}>{tRetro('actions')}</ResizableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {pageItems.map((r) => (
            <ClickableRow
              key={r.id}
              onClick={() => setEditingRetro(r)}
            >
              <TableCell className="text-sm" onClick={(e) => e.stopPropagation()}>
                <div className="flex items-center gap-1.5">
                  {r.projectName == null ? (
                    <span className="text-muted-foreground">{tRetro('private')}</span>
                  ) : r.canAccessProject && r.projectId ? (
                    // perf/comprehensive-perf-2026-06-01 (F): 一覧の各行 Link は default prefetch=true で
                    //   表示中行ぶんの RSC を自動取得し N+1 fetch 化していた (本番計測で 3 プロジェクト×2 fetch を観測)。
                    //   一覧画面ではユーザが実際にクリックするのは 1〜2 件で大半は無駄 fetch のため、
                    //   prefetch={false} で hover/visibility 時の自動 fetch を抑止する。
                    <Link
                      href={`/projects/${r.projectId}`}
                      prefetch={false}
                      className="text-info hover:underline"
                    >
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
                      title={tRetro('linkedProjectsTitle', { count: r.linkedProjectIds.length })}
                    >
                      +{r.linkedProjectIds.length - 1}
                    </Badge>
                  )}
                </div>
              </TableCell>
              <TableCell className="whitespace-nowrap font-medium">{formatDateOnly(r.conductedDate)}</TableCell>
              <TableCell className="text-sm text-muted-foreground">{r.assigneeName || '—'}</TableCell>
              <TableCell className="text-sm text-muted-foreground">
                {r.createdByName ?? <span className="text-muted-foreground">-</span>}
              </TableCell>
              <TableCell className="whitespace-nowrap text-sm text-muted-foreground">{formatDateTimeSeconds(r.createdAt)}</TableCell>
              <TableCell className="text-sm text-muted-foreground">
                {r.updatedAt !== r.createdAt ? (r.updatedByName ?? <span className="text-muted-foreground">-</span>) : <span className="text-muted-foreground">—</span>}
              </TableCell>
              <TableCell className="whitespace-nowrap text-sm text-muted-foreground">{r.updatedAt !== r.createdAt ? formatDateTimeSeconds(r.updatedAt) : '—'}</TableCell>
              {/* リンク列 (url 型添付を縦に複数行) / 添付列 (ファイル本体のみ) */}
              <TableCell onClick={(e) => e.stopPropagation()}>
                <LinksCell items={attachmentsByEntity[r.id] ?? []} />
              </TableCell>
              <TableCell onClick={(e) => e.stopPropagation()}>
                <AttachmentsCell items={(attachmentsByEntity[r.id] ?? []).filter((a) => a.storageProvider === 'supabase')} />
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
              <TableCell colSpan={isAdmin ? 10 : 9} className="py-8 text-center text-muted-foreground">
                {tRetro('noneInList')}
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </ResizableTableShell>

      <TablePagination page={page} pageCount={pageCount} onPageChange={setPage} />

      {/* 2026-06-03: 件数は表の下部に表示 (フィルター位置統一に伴い上部から移動) */}
      <div className="flex justify-end">
        <span className="text-sm text-muted-foreground">{tCommon('itemCount', { count: filteredRetros.length })}</span>
      </div>

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
