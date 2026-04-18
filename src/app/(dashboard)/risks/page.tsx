import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { listAllRisksForViewer } from '@/services/risk.service';
import { PRIORITIES } from '@/types';
import { AdminRiskDeleteButton } from './admin-delete-button';

const typeColors: Record<string, 'default' | 'destructive' | 'outline'> = {
  risk: 'outline',
  issue: 'destructive',
};

/**
 * 日時フォーマット (YYYY-MM-DD HH:mm)
 * テーブル表示用に秒・タイムゾーン表示を省く。
 */
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
 * 全プロジェクト横断のリスク/課題ビュー (Req 4 列構成: PR #55)。
 *
 * 列: プロジェクト・種別・件名・担当者・影響度・発生可能性・優先度・
 *     作成日時・作成者・更新日時・更新者 (+ admin のみ操作)
 */
export default async function AllRisksPage() {
  const session = await auth();
  if (!session) redirect('/login');

  const risks = await listAllRisksForViewer(session.user.id, session.user.systemRole);
  const isAdmin = session.user.systemRole === 'admin';

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">全リスク/課題</h2>
        <span className="text-sm text-gray-500">{risks.length} 件</span>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="whitespace-nowrap">プロジェクト</TableHead>
            <TableHead className="whitespace-nowrap">種別</TableHead>
            <TableHead>件名</TableHead>
            <TableHead className="whitespace-nowrap">担当者</TableHead>
            <TableHead className="whitespace-nowrap">影響度</TableHead>
            <TableHead className="whitespace-nowrap">発生可能性</TableHead>
            <TableHead className="whitespace-nowrap">優先度</TableHead>
            <TableHead className="whitespace-nowrap">作成日時</TableHead>
            <TableHead className="whitespace-nowrap">作成者</TableHead>
            <TableHead className="whitespace-nowrap">更新日時</TableHead>
            <TableHead className="whitespace-nowrap">更新者</TableHead>
            {isAdmin && <TableHead className="whitespace-nowrap">操作</TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {risks.map((r) => (
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
              <TableCell>
                <Badge variant={typeColors[r.type] || 'outline'}>
                  {r.type === 'risk' ? 'リスク' : '課題'}
                </Badge>
              </TableCell>
              <TableCell className="font-medium">{r.title}</TableCell>
              <TableCell className="text-sm text-gray-600">
                {r.assigneeName ?? <span className="text-gray-400">-</span>}
              </TableCell>
              <TableCell>{PRIORITIES[r.impact as keyof typeof PRIORITIES] || r.impact}</TableCell>
              <TableCell>
                {r.likelihood
                  ? PRIORITIES[r.likelihood as keyof typeof PRIORITIES] || r.likelihood
                  : '-'}
              </TableCell>
              <TableCell>{PRIORITIES[r.priority as keyof typeof PRIORITIES] || r.priority}</TableCell>
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
                  <AdminRiskDeleteButton
                    projectId={r.projectId}
                    riskId={r.id}
                    label={r.title}
                  />
                </TableCell>
              )}
            </TableRow>
          ))}
          {risks.length === 0 && (
            <TableRow>
              <TableCell colSpan={isAdmin ? 12 : 11} className="py-8 text-center text-gray-500">
                リスク/課題がありません
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
