import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { prisma } from '@/lib/db';
import { Badge } from '@/components/ui/badge';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';

export default async function AuditLogsPage() {
  const session = await auth();
  if (!session || session.user.systemRole !== 'admin') redirect('/');

  const logs = await prisma.auditLog.findMany({
    include: { user: { select: { name: true } } },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-semibold">監査ログ</h2>
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
              <TableCell className="text-sm">{new Date(log.createdAt).toLocaleString('ja-JP')}</TableCell>
              <TableCell className="text-sm">{log.user.name}</TableCell>
              <TableCell>
                <Badge variant={log.action === 'DELETE' ? 'destructive' : log.action === 'CREATE' ? 'default' : 'secondary'}>
                  {log.action}
                </Badge>
              </TableCell>
              <TableCell className="text-sm">{log.entityType}</TableCell>
              <TableCell className="text-xs font-mono text-gray-400">{log.entityId.slice(0, 8)}...</TableCell>
            </TableRow>
          ))}
          {logs.length === 0 && (
            <TableRow><TableCell colSpan={5} className="py-8 text-center text-gray-500">監査ログがありません</TableCell></TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
