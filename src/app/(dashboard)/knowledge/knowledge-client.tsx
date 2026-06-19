'use client';

/**
 * 全ナレッジ画面 (横断表示) のクライアントコンポーネント。
 *
 * 役割:
 *   プロジェクト横断でナレッジ (knowledges) を一覧・検索表示する (PR #165 で read-only 確定)。
 *   visibility='public' の全件 + 自分が作成した draft が表示対象 (サービス層フィルタ)。
 *
 * 主な機能:
 *   - フリーテキスト検索 (title / content の pg_trgm 類似度)
 *   - knowledgeType でフィルタ
 *   - 行クリックで read-only 詳細ダイアログ (KnowledgeEditDialog readOnly=true)
 *
 * 設計ルール (PR #165 で再確定):
 *   - **「全○○」 = 参照のみ** (本画面)
 *   - **「○○一覧」 = CRUD + 一括編集** (project-tab 内 ProjectKnowledgeClient)
 *   PR #162 で誤って本画面に bulk UI を入れていたが、PR #165 で原状回復。
 *
 * 認可: ログイン済ユーザなら閲覧可。編集/削除はプロジェクト内ナレッジ一覧から作成者本人 or admin。
 * API: /api/knowledge (GET/POST), /api/knowledge/[id] (PATCH/DELETE)
 *
 * 関連:
 *   - SPECIFICATION.md (全ナレッジ画面)
 *   - DESIGN.md §16 (全文検索 / pg_trgm)
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  TableBody,
  TableCell,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { KnowledgeEditDialog } from '@/components/dialogs/knowledge-edit-dialog';
import { KNOWLEDGE_TYPES } from '@/types';
import type { AllKnowledgeDTO } from '@/services/knowledge.service';
import { useFormatters } from '@/lib/use-formatters';
import { matchesAnyKeyword } from '@/lib/text-search';
// Phase E 要件 1〜3 (2026-04-29): 共通行クリック + フィルタバー部品
import { ClickableRow } from '@/components/common/clickable-row';
import { FilterBar } from '@/components/common/filter-bar';
import { useTablePagination, TablePagination } from '@/components/common/table-pagination';
import { useBatchAttachments } from '@/components/attachments/use-batch-attachments';
import { AttachmentsCell } from '@/components/attachments/attachments-cell';
// 2026-06-03: ○○一覧と列構成を統一 (リンク列 / 担当者列 / タイトル列、本文列は撤去)。
import { LinksCell } from '@/components/attachments/links-cell';
import { ResizableHead } from '@/components/ui/resizable-columns';
import { ResizableTableShell } from '@/components/common/resizable-table-shell';
import { SortableResizableHead } from '@/components/sort/sortable-resizable-head';
import { useMultiSort } from '@/components/sort/use-multi-sort';
import { multiSort } from '@/lib/multi-sort';
import { useAutoOpenDialog } from '@/components/common/use-auto-open-dialog';
import { useListSearchParams } from '@/components/common/use-list-search-params';
import { AdminKnowledgeDeleteButton } from './admin-delete-button';

function getKnowledgeSortValue(k: AllKnowledgeDTO, columnKey: string): unknown {
  switch (columnKey) {
    case 'project': return k.projectName ?? '';
    case 'title': return k.title;
    case 'type': return k.knowledgeType;
    case 'assigneeName': return k.assigneeName ?? '';
    case 'createdAt': return k.createdAt;
    case 'createdBy': return k.creatorName ?? '';
    case 'updatedAt': return k.updatedAt;
    case 'updatedBy': return k.updatedByName ?? '';
    default: return null;
  }
}

type Props = {
  initialKnowledge: AllKnowledgeDTO[];
  systemRole: string;
  /** PR #425 (2026-05-22) KDD §5.X+102: URL ?keyword=&type= 復元用 */
  initialKeyword?: string;
  initialTypeFilter?: string;
};

export function KnowledgeClient({ initialKnowledge, systemRole, initialKeyword = '', initialTypeFilter = '' }: Props) {
  const router = useRouter();
  const tKnowledge = useTranslations('knowledge');
  const tCommon = useTranslations('common');
  const { formatDateTimeSeconds } = useFormatters();
  const isAdmin = systemRole === 'admin';
  // PR #425 (2026-05-22) KDD §5.X+102: 入力即フィルタ + URL ?keyword=&type= 永続化
  const { keyword, setKeyword, filters, setFilter } = useListSearchParams<{ type: string }>({
    initialKeyword,
    initialFilters: { type: initialTypeFilter },
  });
  const typeFilter = filters.type;
  const setTypeFilter = (v: string) => setFilter('type', v);
  const [editingKnowledge, setEditingKnowledge] = useState<AllKnowledgeDTO | null>(null);

  // PR feat/sortable-columns (2026-05-01): カラムソート (sessionStorage 永続化、複数列対応)
  const { sortState, setSortColumn } = useMultiSort('sort:all-knowledge');

  const baseFiltered = initialKnowledge.filter((k) => {
    if (typeFilter && k.knowledgeType !== typeFilter) return false;
    // Phase C 要件 19 (2026-04-28): 空白区切りで OR 検索
    if (!matchesAnyKeyword(keyword, [k.title, k.background, k.content, k.result])) return false;
    return true;
  });
  const filtered = multiSort(baseFiltered, sortState, getKnowledgeSortValue);
  const { pageItems, page, pageCount, setPage } = useTablePagination(filtered, `${keyword}|${typeFilter}`);

  const attachmentsByEntity = useBatchAttachments(
    'knowledge',
    filtered.map((k) => k.id),
  );

  // PR feat/notification-edit-dialog: mention 通知 link `?knowledgeId=...` から auto-open。
  useAutoOpenDialog<AllKnowledgeDTO>({
    queryKey: 'knowledgeId',
    items: initialKnowledge,
    onOpen: (k) => setEditingKnowledge(k),
  });

  return (
    <div className="space-y-6">
      {/* 2026-06-03: フィルター位置をプロジェクト一覧に統一。FilterBar を先頭に置き、件数は表の下部へ移動。 */}
      <FilterBar>
        <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
          <div className="md:col-span-2">
            <Label htmlFor="all-knowledge-filter-keyword" className="text-xs">{tKnowledge('keyword')}</Label>
            <Input
              id="all-knowledge-filter-keyword"
              placeholder={tKnowledge('searchPlaceholder')}
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              data-testid="all-knowledge-search-input"
            />
          </div>
          <div>
            <Label htmlFor="all-knowledge-filter-type" className="text-xs">{tKnowledge('kind')}</Label>
            {/* Phase A 要件 15: 種別フィルタの選択後表示が内部名になる問題を修正。
                SelectValue の children render 関数で KNOWLEDGE_TYPES から表示名にマップする。 */}
            <Select value={typeFilter || '__all__'} onValueChange={(v) => setTypeFilter((v ?? '__all__') === '__all__' ? '' : (v ?? ''))}>
              <SelectTrigger id="all-knowledge-filter-type">
                <SelectValue placeholder={tKnowledge('all')}>
                  {(value) => {
                    if (!value || value === '__all__') return tKnowledge('all');
                    return KNOWLEDGE_TYPES[value as keyof typeof KNOWLEDGE_TYPES] || value;
                  }}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">{tKnowledge('all')}</SelectItem>
                {Object.entries(KNOWLEDGE_TYPES).map(([key, label]) => (
                  <SelectItem key={key} value={key}>{label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </FilterBar>

      <ResizableTableShell tableKey="all-knowledge">
          <TableHeader>
            <TableRow>
              {/* 2026-06-03: ナレッジ一覧(タブ)と列構成を統一 — プロジェクト + タイトル・種別・担当者・監査4・リンク・添付・操作。
                  本文列(背景/内容/結果)は詳細ダイアログでのみ表示するため一覧からは撤去。 */}
              <SortableResizableHead columnKey="project" defaultWidth={140} label={tKnowledge('project')} sortState={sortState} onSortChange={setSortColumn} />
              <SortableResizableHead columnKey="title" defaultWidth={240} label={tKnowledge('fieldTitle')} sortState={sortState} onSortChange={setSortColumn} />
              <SortableResizableHead columnKey="type" defaultWidth={100} label={tKnowledge('kind')} sortState={sortState} onSortChange={setSortColumn} />
              <SortableResizableHead columnKey="assigneeName" defaultWidth={120} label={tKnowledge('assignee')} sortState={sortState} onSortChange={setSortColumn} />
              <SortableResizableHead columnKey="createdBy" defaultWidth={120} label={tKnowledge('createdBy')} sortState={sortState} onSortChange={setSortColumn} />
              <SortableResizableHead columnKey="createdAt" defaultWidth={150} label={tKnowledge('createdAt')} sortState={sortState} onSortChange={setSortColumn} />
              <SortableResizableHead columnKey="updatedBy" defaultWidth={120} label={tKnowledge('updatedBy')} sortState={sortState} onSortChange={setSortColumn} />
              <SortableResizableHead columnKey="updatedAt" defaultWidth={150} label={tKnowledge('updatedAt')} sortState={sortState} onSortChange={setSortColumn} />
              <ResizableHead columnKey="links" defaultWidth={200}>{tKnowledge('links')}</ResizableHead>
              <ResizableHead columnKey="attachments" defaultWidth={180}>{tKnowledge('attachment')}</ResizableHead>
              {isAdmin && <ResizableHead columnKey="actions" defaultWidth={80}>{tKnowledge('actions')}</ResizableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {pageItems.map((k) => (
              <ClickableRow
                key={k.id}
                onClick={() => setEditingKnowledge(k)}
              >
                <TableCell className="text-sm" onClick={(e) => e.stopPropagation()}>
                  {k.projectName == null ? (
                    <span className="text-muted-foreground">
                      {k.linkedProjectCount === 0 ? tKnowledge('notLinked') : tKnowledge('private')}
                    </span>
                  ) : k.canAccessProject && k.primaryProjectId ? (
                    // perf/comprehensive-perf-2026-06-01 (F): 一覧行 Link 自動 prefetch 抑止
                    <Link
                      href={`/projects/${k.primaryProjectId}`}
                      prefetch={false}
                      className="text-info hover:underline"
                    >
                      {k.projectName}
                      {k.linkedProjectCount > 1 && (
                        <span className="ml-1 text-xs text-muted-foreground">{tKnowledge('linkedMoreSuffix', { count: k.linkedProjectCount - 1 })}</span>
                      )}
                    </Link>
                  ) : (
                    <span className="text-muted-foreground">
                      {k.projectName}
                      {k.projectDeleted && <span className="ml-1 text-xs text-destructive">{tKnowledge('deleted')}</span>}
                      {k.linkedProjectCount > 1 && (
                        <span className="ml-1 text-xs text-muted-foreground">{tKnowledge('linkedMoreSuffix', { count: k.linkedProjectCount - 1 })}</span>
                      )}
                    </span>
                  )}
                </TableCell>
                <TableCell className="font-medium">{k.title}</TableCell>
                <TableCell>
                  <Badge variant="secondary">
                    {KNOWLEDGE_TYPES[k.knowledgeType as keyof typeof KNOWLEDGE_TYPES] || k.knowledgeType}
                  </Badge>
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">{k.assigneeName || '—'}</TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {k.creatorName ?? <span className="text-muted-foreground">-</span>}
                </TableCell>
                <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                  {formatDateTimeSeconds(k.createdAt)}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {k.updatedAt !== k.createdAt ? (k.updatedByName ?? <span className="text-muted-foreground">-</span>) : <span className="text-muted-foreground">—</span>}
                </TableCell>
                <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                  {k.updatedAt !== k.createdAt ? formatDateTimeSeconds(k.updatedAt) : '—'}
                </TableCell>
                {/* リンク列 (url 型添付を縦に複数行) / 添付列 (ファイル本体のみ) */}
                <TableCell onClick={(e) => e.stopPropagation()}>
                  <LinksCell items={attachmentsByEntity[k.id] ?? []} />
                </TableCell>
                <TableCell onClick={(e) => e.stopPropagation()}>
                  <AttachmentsCell items={(attachmentsByEntity[k.id] ?? []).filter((a) => a.storageProvider === 'supabase')} />
                </TableCell>
                {isAdmin && (
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <AdminKnowledgeDeleteButton knowledgeId={k.id} label={k.title} />
                  </TableCell>
                )}
              </ClickableRow>
            ))}
            {filtered.length === 0 && (
              <TableRow>
                <TableCell colSpan={isAdmin ? 11 : 10} className="py-8 text-center text-muted-foreground">
                  {tKnowledge('noneInList')}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
      </ResizableTableShell>

      <TablePagination page={page} pageCount={pageCount} onPageChange={setPage} />

      {/* 2026-06-03: 件数は表の下部に表示 (フィルター位置統一に伴い上部から移動) */}
      <div className="flex justify-end">
        <span className="text-sm text-muted-foreground">{tCommon('itemCount', { count: filtered.length })}</span>
      </div>

      <KnowledgeEditDialog
        knowledge={editingKnowledge}
        projectId={editingKnowledge?.primaryProjectId ?? null}
        open={editingKnowledge != null}
        onOpenChange={(v) => { if (!v) setEditingKnowledge(null); }}
        onSaved={async () => { router.refresh(); }}
        // 2026-04-24 + PR #165: 全ナレッジは編集不可 (読み取り専用)。編集は ○○一覧 経由。
        readOnly={true}
      />
    </div>
  );
}
