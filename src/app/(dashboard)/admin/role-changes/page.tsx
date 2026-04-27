import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
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

  const t = await getTranslations('admin.roleChanges');
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
      <h2 className="text-xl font-semibold">{t('title')}</h2>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('columnDateTime')}</TableHead>
            <TableHead>{t('columnChanger')}</TableHead>
            <TableHead>{t('columnTargetUser')}</TableHead>
            <TableHead>{t('columnChangeType')}</TableHead>
            <TableHead>{t('columnBeforeRole')}</TableHead>
            <TableHead>{t('columnAfterRole')}</TableHead>
            <TableHead>{t('columnReason')}</TableHead>
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
            <TableRow><TableCell colSpan={7} className="py-8 text-center text-muted-foreground">{t('noLogs')}</TableCell></TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
