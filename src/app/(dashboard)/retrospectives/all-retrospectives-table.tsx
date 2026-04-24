'use client';

/**
 * 全振り返り画面 (横断表示) のテーブルコンポーネント。
 *
 * 役割:
 *   全プロジェクト横断で visibility='public' の振り返りを一覧表示する。
 *   PMO や次担当者が「過去案件で何が起きたか」を一覧で確認できるナレッジ資産ビュー。
 *
 * 行クリック動作:
 *   メンバーシップがあるプロジェクトの振り返りなら編集ダイアログ、
 *   非メンバーなら参照専用 (read-only) ダイアログを開く (PR #61)。
 *
 * 関連: SPECIFICATION.md (全振り返り画面)
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  Table, TableBody, TableCell, TableHeader, TableRow,
} from '@/components/ui/table';
import { RetrospectiveEditDialog } from '@/components/dialogs/retrospective-edit-dialog';
import type { AllRetroDTO } from '@/services/retrospective.service';
import { AdminRetrospectiveDeleteButton } from './admin-delete-button';
import { formatDateTime } from '@/lib/format';
import { useBatchAttachments } from '@/components/attachments/use-batch-attachments';
import { AttachmentsCell } from '@/components/attachments/attachments-cell';
import {
  ResizableColumnsProvider,
  ResizableHead,
  ResetColumnsButton,
} from '@/components/ui/resizable-columns';

/**
 * 全振り返りテーブル (2026-04-24: 全員読み取り専用に変更)。
 * 編集はプロジェクト内「振り返り一覧」から作成者本人のみ。admin は管理削除のみ可。
 */
export function AllRetrospectivesTable({
  retros,
  isAdmin,
}: {
  retros: AllRetroDTO[];
  isAdmin: boolean;
}) {
  const router = useRouter();
  const [editingRetro, setEditingRetro] = useState<AllRetroDTO | null>(null);
  // PR #67: 添付列用のバッチ取得
  const attachmentsByEntity = useBatchAttachments(
    'retrospective',
    retros.map((r) => r.id),
  );

  return (
    <ResizableColumnsProvider tableKey="all-retrospectives">
      <div className="flex justify-end pb-2">
        <ResetColumnsButton />
      </div>
      <Table>
        <TableHeader>
          <TableRow>
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
            {/* PR #67: 添付リンク列 */}
            <ResizableHead columnKey="attachments" defaultWidth={200}>添付</ResizableHead>
            {isAdmin && <ResizableHead columnKey="actions" defaultWidth={80}>操作</ResizableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {retros.map((r) => (
            <TableRow
              key={r.id}
              className="cursor-pointer hover:bg-muted"
              onClick={() => setEditingRetro(r)}
            >
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
              {/* PR #67: 添付リンク chips */}
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
          {retros.length === 0 && (
            <TableRow>
              {/* PR #67: 添付列を +1 */}
              <TableCell colSpan={isAdmin ? 12 : 11} className="py-8 text-center text-muted-foreground">
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
        // 2026-04-24: 全振り返りは編集不可 (読み取り専用)。編集は ○○一覧 経由。
        readOnly={true}
      />
    </ResizableColumnsProvider>
  );
}
