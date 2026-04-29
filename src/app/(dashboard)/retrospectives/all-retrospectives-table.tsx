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

export function AllRetrospectivesTable({
  retros,
  isAdmin,
}: {
  retros: AllRetroDTO[];
  isAdmin: boolean;
}) {
  const router = useRouter();
  const tRetro = useTranslations('retro');
  const { formatDateTime } = useFormatters();
  const [editingRetro, setEditingRetro] = useState<AllRetroDTO | null>(null);

  // PR-δ / 項目 12: 全振り返りに検索 (keyword) フィルタを追加。
  // 振り返り画面 (RetrospectivesClient) と同様にキーワードで本文/良かった点/改善点を絞り込み。
  const [filter, setFilter] = useState({ keyword: '' });

  const filteredRetros = useMemo(() => {
    if (!filter.keyword.trim()) return retros;
    // Phase C 要件 19 (2026-04-28): 空白区切りで OR 検索
    return retros.filter((r) =>
      matchesAnyKeyword(filter.keyword, [
        r.planSummary,
        r.actualSummary,
        r.goodPoints,
        r.improvements,
      ]),
    );
  }, [retros, filter]);

  const attachmentsByEntity = useBatchAttachments(
    'retrospective',
    filteredRetros.map((r) => r.id),
  );

  return (
    <>
      {/* PR-δ / 項目 12: 検索フィルタ (○○一覧と同 UX に揃える) */}
      <FilterBar className="mb-3">
        <div>
          <Label htmlFor="all-retros-filter-keyword" className="text-xs">{tRetro('keyword')}</Label>
          <Input
            id="all-retros-filter-keyword"
            value={filter.keyword}
            onChange={(e) => setFilter({ keyword: e.target.value })}
            placeholder={tRetro('keywordPlaceholder')}
          />
        </div>
      </FilterBar>
      <ResizableTableShell tableKey="all-retrospectives">
        <TableHeader>
          <TableRow>
            <ResizableHead columnKey="project" defaultWidth={140}>{tRetro('project')}</ResizableHead>
            <ResizableHead columnKey="conductedDate" defaultWidth={110}>{tRetro('conductedDate')}</ResizableHead>
            <ResizableHead columnKey="planSummary" defaultWidth={180}>{tRetro('planSummary')}</ResizableHead>
            <ResizableHead columnKey="actualSummary" defaultWidth={180}>{tRetro('actualSummary')}</ResizableHead>
            <ResizableHead columnKey="goodPoints" defaultWidth={180}>{tRetro('goodPoints')}</ResizableHead>
            <ResizableHead columnKey="improvements" defaultWidth={180}>{tRetro('improvementsTable')}</ResizableHead>
            <ResizableHead columnKey="createdAt" defaultWidth={130}>{tRetro('createdAt')}</ResizableHead>
            <ResizableHead columnKey="createdBy" defaultWidth={120}>{tRetro('createdBy')}</ResizableHead>
            <ResizableHead columnKey="updatedAt" defaultWidth={130}>{tRetro('updatedAt')}</ResizableHead>
            <ResizableHead columnKey="updatedBy" defaultWidth={120}>{tRetro('updatedBy')}</ResizableHead>
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
                {r.projectName == null ? (
                  <span className="text-muted-foreground">{tRetro('private')}</span>
                ) : r.canAccessProject ? (
                  <Link href={`/projects/${r.projectId}`} className="text-info hover:underline">
                    {r.projectName}
                  </Link>
                ) : (
                  <span className="text-muted-foreground">
                    {r.projectName}
                    {r.projectDeleted && <span className="ml-1 text-xs text-destructive">{tRetro('deleted')}</span>}
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
    </>
  );
}
