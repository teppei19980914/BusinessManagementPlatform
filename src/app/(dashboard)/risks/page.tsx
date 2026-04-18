import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { listAllRisksForViewer } from '@/services/risk.service';
import { PRIORITIES, RISK_ISSUE_STATES } from '@/types';

const typeColors: Record<string, 'default' | 'destructive' | 'outline'> = {
  risk: 'outline',
  issue: 'destructive',
};

/**
 * 全プロジェクト横断のリスク/課題ビュー。
 *
 * 認可方針 (Phase B):
 *   - 認証済みユーザなら誰でも閲覧可
 *   - 非メンバーには projectName / 担当者名 / 起票者名をマスクして表示
 *   - 詳細画面リンクは メンバー (canAccessProject=true) のみ表示
 *   - 作成はプロジェクト詳細画面からのみ (ここには作成ボタンを置かない)
 */
export default async function AllRisksPage() {
  const session = await auth();
  if (!session) redirect('/login');

  const risks = await listAllRisksForViewer(session.user.id);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">全リスク/課題</h2>
        <span className="text-sm text-gray-500">{risks.length} 件</span>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>種別</TableHead>
            <TableHead>件名</TableHead>
            <TableHead>プロジェクト</TableHead>
            <TableHead>影響度</TableHead>
            <TableHead>優先度</TableHead>
            <TableHead>状態</TableHead>
            <TableHead>担当者</TableHead>
            <TableHead>期限</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {risks.map((r) => (
            <TableRow key={r.id}>
              <TableCell>
                <Badge variant={typeColors[r.type] || 'outline'}>
                  {r.type === 'risk' ? 'リスク' : '課題'}
                </Badge>
              </TableCell>
              <TableCell className="font-medium">
                {/* 詳細リンクはメンバーのみ。非メンバーには title のみテキスト表示 */}
                {r.canAccessProject ? (
                  <Link
                    href={`/projects/${r.projectId}/risks`}
                    className="text-blue-600 hover:underline"
                  >
                    {r.title}
                  </Link>
                ) : (
                  <span>{r.title}</span>
                )}
              </TableCell>
              <TableCell className="text-sm text-gray-600">
                {r.projectName ?? <span className="text-gray-400">（非公開）</span>}
              </TableCell>
              <TableCell>{PRIORITIES[r.impact as keyof typeof PRIORITIES] || r.impact}</TableCell>
              <TableCell>{PRIORITIES[r.priority as keyof typeof PRIORITIES] || r.priority}</TableCell>
              <TableCell>
                {RISK_ISSUE_STATES[r.state as keyof typeof RISK_ISSUE_STATES] || r.state}
              </TableCell>
              <TableCell className="text-sm text-gray-600">
                {r.assigneeName ?? <span className="text-gray-400">-</span>}
              </TableCell>
              <TableCell>{r.deadline || '-'}</TableCell>
            </TableRow>
          ))}
          {risks.length === 0 && (
            <TableRow>
              <TableCell colSpan={8} className="py-8 text-center text-gray-500">
                リスク/課題がありません
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
