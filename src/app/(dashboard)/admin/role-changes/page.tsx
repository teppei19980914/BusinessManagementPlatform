import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { prisma } from '@/lib/db';
// PR #117 → PR #119: session 連携フォーマッタ (ユーザ個別 TZ/locale を反映)
import { getServerFormatters } from '@/lib/server-formatters';
import { RoleChangesTable, type RoleChangeRow } from './role-changes-table';

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

  // PR feat/sortable-columns: client component (sortable) に渡せるよう plain object に整形。
  const rows: RoleChangeRow[] = logs.map((log) => ({
    id: log.id,
    createdAtIso: log.createdAt.toISOString(),
    createdAtDisplay: formatDateTimeFull(log.createdAt.toISOString()),
    changerName: log.changer.name,
    targetUserName: log.targetUser.name,
    changeType: log.changeType,
    beforeRole: log.beforeRole,
    afterRole: log.afterRole,
    reason: log.reason,
  }));

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-semibold">{t('title')}</h2>
      <RoleChangesTable logs={rows} />
    </div>
  );
}
