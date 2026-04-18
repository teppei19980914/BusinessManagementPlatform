'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { RetrospectiveEditDialog } from '@/components/dialogs/retrospective-edit-dialog';
import type { AllRetroDTO } from '@/services/retrospective.service';
import { AdminRetrospectiveDeleteButton } from './admin-delete-button';

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${day} ${hh}:${mm}`;
}

/**
 * 全振り返りテーブル (Req 9: 行クリックで編集)。
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

  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="whitespace-nowrap">プロジェクト</TableHead>
            <TableHead className="whitespace-nowrap">実施日</TableHead>
            <TableHead>計画総括</TableHead>
            <TableHead>実績総括</TableHead>
            <TableHead>良かった点</TableHead>
            <TableHead>次回以前事項</TableHead>
            <TableHead className="whitespace-nowrap">作成日時</TableHead>
            <TableHead className="whitespace-nowrap">作成者</TableHead>
            <TableHead className="whitespace-nowrap">更新日時</TableHead>
            <TableHead className="whitespace-nowrap">更新者</TableHead>
            {isAdmin && <TableHead className="whitespace-nowrap">操作</TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {retros.map((r) => (
            <TableRow
              key={r.id}
              className={r.canAccessProject ? 'cursor-pointer hover:bg-gray-50' : ''}
              onClick={r.canAccessProject ? () => setEditingRetro(r) : undefined}
            >
              <TableCell className="text-sm" onClick={(e) => e.stopPropagation()}>
                {r.projectName == null ? (
                  <span className="text-gray-400">（非公開）</span>
                ) : r.canAccessProject ? (
                  <Link href={`/projects/${r.projectId}`} className="text-blue-600 hover:underline">
                    {r.projectName}
                  </Link>
                ) : (
                  <span className="text-gray-500">
                    {r.projectName}
                    {r.projectDeleted && <span className="ml-1 text-xs text-red-500">(削除済)</span>}
                  </span>
                )}
              </TableCell>
              <TableCell className="whitespace-nowrap font-medium">{r.conductedDate}</TableCell>
              <TableCell className="max-w-xs truncate text-sm">{r.planSummary || '-'}</TableCell>
              <TableCell className="max-w-xs truncate text-sm">{r.actualSummary || '-'}</TableCell>
              <TableCell className="max-w-xs truncate text-sm">{r.goodPoints || '-'}</TableCell>
              <TableCell className="max-w-xs truncate text-sm">{r.improvements || '-'}</TableCell>
              <TableCell className="whitespace-nowrap text-sm text-gray-600">{formatDateTime(r.createdAt)}</TableCell>
              <TableCell className="text-sm text-gray-600">
                {r.createdByName ?? <span className="text-gray-400">-</span>}
              </TableCell>
              <TableCell className="whitespace-nowrap text-sm text-gray-600">{formatDateTime(r.updatedAt)}</TableCell>
              <TableCell className="text-sm text-gray-600">
                {r.updatedByName ?? <span className="text-gray-400">-</span>}
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
              <TableCell colSpan={isAdmin ? 11 : 10} className="py-8 text-center text-gray-500">
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
      />
    </>
  );
}
