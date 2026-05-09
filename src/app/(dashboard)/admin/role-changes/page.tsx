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

  // 2026-05-09 feedback: severity-1 テナント越境対策。
  //   旧仕様では他テナントの全 role_change_log (誰がいつ誰の権限を変更したか) が
  //   テナント A の admin に閲覧可能だった。RoleChangeLog は tenantId 列を持たないため
  //   targetUser リレーション経由で自テナント限定する (changer も同テナント前提)。
  const logs = await prisma.roleChangeLog.findMany({
    where: { targetUser: { tenantId: session.user.tenantId } },
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
