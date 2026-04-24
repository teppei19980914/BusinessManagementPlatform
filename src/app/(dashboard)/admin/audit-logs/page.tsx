import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { prisma } from '@/lib/db';
import { Badge } from '@/components/ui/badge';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
// PR #117 → PR #119: session 連携フォーマッタ (ユーザ個別 TZ/locale を反映)
import { getServerFormatters } from '@/lib/server-formatters';

export default async function AuditLogsPage() {
  const session = await auth();
  if (!session || session.user.systemRole !== 'admin') redirect('/');

  const { formatDateTimeFull } = await getServerFormatters();

  const logs = await prisma.auditLog.findMany({
    include: { user: { select: { name: true } } },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-semibold">監査ログ</h2>
      {/* PR #128c: PC は既存テーブル、モバイルはカード形式 */}
      <div className="hidden md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>日時</TableHead>
              <TableHead>操作者</TableHead>
              <TableHead>操作</TableHead>
              <TableHead>対象</TableHead>
              <TableHead>対象ID</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {logs.map((log) => (
              <TableRow key={log.id}>
                <TableCell className="text-sm">{formatDateTimeFull(log.createdAt.toISOString())}</TableCell>
                <TableCell className="text-sm">{log.user.name}</TableCell>
                <TableCell>
                  <Badge variant={log.action === 'DELETE' ? 'destructive' : log.action === 'CREATE' ? 'default' : 'secondary'}>
                    {log.action}
                  </Badge>
                </TableCell>
                <TableCell className="text-sm">{log.entityType}</TableCell>
                <TableCell className="text-xs font-mono text-muted-foreground">{log.entityId.slice(0, 8)}...</TableCell>
              </TableRow>
            ))}
            {logs.length === 0 && (
              <TableRow><TableCell colSpan={5} className="py-8 text-center text-muted-foreground">監査ログがありません</TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {/* モバイル: カード */}
      <div className="space-y-2 md:hidden" role="list" aria-label="監査ログ一覧">
        {logs.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">監査ログがありません</p>
        ) : (
          logs.map((log) => (
            <div key={log.id} role="listitem" className="rounded-md border bg-card p-3 text-sm">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <Badge variant={log.action === 'DELETE' ? 'destructive' : log.action === 'CREATE' ? 'default' : 'secondary'} className="text-[10px]">
                  {log.action}
                </Badge>
                <span className="font-medium">{log.entityType}</span>
              </div>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                <dt className="text-xs text-muted-foreground">日時</dt>
                <dd className="text-xs">{formatDateTimeFull(log.createdAt.toISOString())}</dd>
                <dt className="text-xs text-muted-foreground">操作者</dt>
                <dd className="text-xs">{log.user.name}</dd>
                <dt className="text-xs text-muted-foreground">対象ID</dt>
                <dd className="text-xs font-mono text-muted-foreground break-all">{log.entityId}</dd>
              </dl>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
