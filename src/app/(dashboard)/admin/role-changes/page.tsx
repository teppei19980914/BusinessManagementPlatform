import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { prisma } from '@/lib/db';
import { Badge } from '@/components/ui/badge';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
// PR #117 → PR #119: session 連携フォーマッタ (ユーザ個別 TZ/locale を反映)
import { getServerFormatters } from '@/lib/server-formatters';

export default async function RoleChangesPage() {
  const session = await auth();
  if (!session || session.user.systemRole !== 'admin') redirect('/');

  const { formatDateTimeFull } = await getServerFormatters();

  const logs = await prisma.roleChangeLog.findMany({
    include: {
      changer: { select: { name: true } },
      targetUser: { select: { name: true, email: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-semibold">権限変更履歴</h2>
      {/* PR #128c: PC は既存テーブル、モバイルはカード */}
      <div className="hidden md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>日時</TableHead>
              <TableHead>変更者</TableHead>
              <TableHead>対象ユーザ</TableHead>
              <TableHead>種別</TableHead>
              <TableHead>変更前</TableHead>
              <TableHead>変更後</TableHead>
              <TableHead>理由</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {logs.map((log) => (
              <TableRow key={log.id}>
                <TableCell className="text-sm">{formatDateTimeFull(log.createdAt.toISOString())}</TableCell>
                <TableCell className="text-sm">{log.changer.name}</TableCell>
                <TableCell className="text-sm">{log.targetUser.name}</TableCell>
                <TableCell><Badge variant="secondary">{log.changeType}</Badge></TableCell>
                <TableCell className="text-sm">{log.beforeRole || '-'}</TableCell>
                <TableCell className="text-sm font-medium">{log.afterRole}</TableCell>
                <TableCell className="text-sm text-muted-foreground">{log.reason || '-'}</TableCell>
              </TableRow>
            ))}
            {logs.length === 0 && (
              <TableRow><TableCell colSpan={7} className="py-8 text-center text-muted-foreground">権限変更履歴がありません</TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {/* モバイル: カード */}
      <div className="space-y-2 md:hidden" role="list" aria-label="権限変更履歴一覧">
        {logs.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">権限変更履歴がありません</p>
        ) : (
          logs.map((log) => (
            <div key={log.id} role="listitem" className="rounded-md border bg-card p-3 text-sm">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <Badge variant="secondary" className="text-[10px]">{log.changeType}</Badge>
                <span className="font-medium">{log.targetUser.name}</span>
                <span className="text-xs text-muted-foreground">
                  {log.beforeRole || '-'} → <span className="font-medium text-foreground">{log.afterRole}</span>
                </span>
              </div>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                <dt className="text-xs text-muted-foreground">日時</dt>
                <dd className="text-xs">{formatDateTimeFull(log.createdAt.toISOString())}</dd>
                <dt className="text-xs text-muted-foreground">変更者</dt>
                <dd className="text-xs">{log.changer.name}</dd>
                {log.reason && (
                  <>
                    <dt className="text-xs text-muted-foreground">理由</dt>
                    <dd className="text-xs line-clamp-3">{log.reason}</dd>
                  </>
                )}
              </dl>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
