import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { listAllRetrospectivesForViewer } from '@/services/retrospective.service';

/**
 * 全プロジェクト横断の振り返りビュー。
 *
 * 認可方針 (Phase B):
 *   - 認証済みユーザなら誰でも閲覧可
 *   - 非メンバーには projectName / コメント投稿者氏名をマスクして表示
 *   - 詳細画面リンクは メンバー (canAccessProject=true) のみ表示
 *   - 作成はプロジェクト詳細画面からのみ
 */
export default async function AllRetrospectivesPage() {
  const session = await auth();
  if (!session) redirect('/login');

  const retros = await listAllRetrospectivesForViewer(session.user.id);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">全振り返り</h2>
        <span className="text-sm text-gray-500">{retros.length} 件</span>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>実施日</TableHead>
            <TableHead>プロジェクト</TableHead>
            <TableHead>良かった点 (抜粋)</TableHead>
            <TableHead>課題 (抜粋)</TableHead>
            <TableHead>状態</TableHead>
            <TableHead>コメント</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {retros.map((r) => (
            <TableRow key={r.id}>
              <TableCell className="whitespace-nowrap font-medium">
                {r.canAccessProject ? (
                  <Link
                    href={`/projects/${r.projectId}/retrospectives`}
                    className="text-blue-600 hover:underline"
                  >
                    {r.conductedDate}
                  </Link>
                ) : (
                  <span>{r.conductedDate}</span>
                )}
              </TableCell>
              <TableCell className="text-sm text-gray-600">
                {r.projectName ?? <span className="text-gray-400">（非公開）</span>}
              </TableCell>
              <TableCell className="max-w-xs truncate text-sm">{r.goodPoints || '-'}</TableCell>
              <TableCell className="max-w-xs truncate text-sm">{r.problems || '-'}</TableCell>
              <TableCell>
                <Badge variant={r.state === 'confirmed' ? 'default' : 'outline'}>
                  {r.state === 'confirmed' ? '確定' : '作成中'}
                </Badge>
              </TableCell>
              <TableCell>{r.comments.length} 件</TableCell>
            </TableRow>
          ))}
          {retros.length === 0 && (
            <TableRow>
              <TableCell colSpan={6} className="py-8 text-center text-gray-500">
                振り返りがありません
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
