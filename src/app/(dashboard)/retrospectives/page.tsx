import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { listAllRetrospectivesForViewer } from '@/services/retrospective.service';
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
 * 全プロジェクト横断の振り返りビュー (Req 4 列構成: PR #55)。
 *
 * 列: プロジェクト・実施日・計画総括・実績総括・良かった点・次回以前事項・
 *     作成日時・作成者・更新日時・更新者 (+ admin のみ操作)
 */
export default async function AllRetrospectivesPage() {
  const session = await auth();
  if (!session) redirect('/login');

  const retros = await listAllRetrospectivesForViewer(session.user.id, session.user.systemRole);
  const isAdmin = session.user.systemRole === 'admin';

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">全振り返り</h2>
        <span className="text-sm text-gray-500">{retros.length} 件</span>
      </div>

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
            <TableRow key={r.id}>
              <TableCell className="text-sm">
                {r.projectName == null ? (
                  <span className="text-gray-400">（非公開）</span>
                ) : r.canAccessProject ? (
                  <Link
                    href={`/projects/${r.projectId}`}
                    className="text-blue-600 hover:underline"
                  >
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
              <TableCell className="whitespace-nowrap text-sm text-gray-600">
                {formatDateTime(r.createdAt)}
              </TableCell>
              <TableCell className="text-sm text-gray-600">
                {r.createdByName ?? <span className="text-gray-400">-</span>}
              </TableCell>
              <TableCell className="whitespace-nowrap text-sm text-gray-600">
                {formatDateTime(r.updatedAt)}
              </TableCell>
              <TableCell className="text-sm text-gray-600">
                {r.updatedByName ?? <span className="text-gray-400">-</span>}
              </TableCell>
              {isAdmin && (
                <TableCell>
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
    </div>
  );
}
