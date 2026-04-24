import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { prisma } from '@/lib/db';
import { Badge } from '@/components/ui/badge';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
// PR #117: JST 固定タイムゾーン描画 (runtime TZ に依存しない一貫表記)
import { formatDateTimeFull } from '@/lib/format';

export default async function RoleChangesPage() {
  const session = await auth();
  if (!session || session.user.systemRole !== 'admin') redirect('/');

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
  );
}
