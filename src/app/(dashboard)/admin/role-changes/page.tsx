import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { prisma } from '@/lib/db';
// PR #117 → PR #119: session 連携フォーマッタ (ユーザ個別 TZ/locale を反映)
import { getServerFormatters } from '@/lib/server-formatters';
import { isAdminOrAbove } from '@/lib/permissions';
import { RoleChangesTable, type RoleChangeRow } from './role-changes-table';

export default async function RoleChangesPage() {
  const session = await auth();
  // feat/crud-permission-redesign (2026-05-20): API 側 requireAdmin と整合 (admin + super_admin)
  if (!session || !isAdminOrAbove(session.user)) redirect('/');

  const t = await getTranslations('admin.roleChanges');
  const { formatDateTimeFull } = await getServerFormatters();

  // 2026-05-10 Phase 2-10: RoleChangeLog 直接 tenantId 列で絞込み (旧 targetUser join 経由から移行)。
  //   indexed lookup で高速、User 物理削除後の追従も可能。
  const logs = await prisma.roleChangeLog.findMany({
    where: { tenantId: session.user.tenantId },
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
