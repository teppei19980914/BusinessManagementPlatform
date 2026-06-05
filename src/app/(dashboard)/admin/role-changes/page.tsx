import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { prisma } from '@/lib/db';
// PR #117 → PR #119: session 連携フォーマッタ (ユーザ個別 TZ/locale を反映)
import { getServerFormatters } from '@/lib/server-formatters';
import { isAdminOrAbove } from '@/lib/permissions';
import { SYSTEM_ROLES, PROJECT_ROLES } from '@/config/master-data';
import { RoleChangesTable, type RoleChangeRow } from './role-changes-table';

// 2026-06-03: 監査ログと同様に画面から選べる表示件数。?limit= で URL 永続化。既定 300。'all' = 全件。
const ROLE_CHANGE_LIMIT_OPTIONS = ['100', '300', '1000', 'all'] as const;
const DEFAULT_ROLE_CHANGE_LIMIT = '300';

export default async function RoleChangesPage({
  searchParams,
}: {
  searchParams: Promise<{ limit?: string }>;
}) {
  const session = await auth();
  // feat/crud-permission-redesign (2026-05-20): API 側 requireAdmin と整合 (admin + super_admin)
  if (!session || !isAdminOrAbove(session.user)) redirect('/');

  const t = await getTranslations('admin.roleChanges');
  const { formatDateTimeFull } = await getServerFormatters();

  // 2026-06-03: 表示件数は ?limit= から取得 (許可値のみ採用、不正値は既定 300)。'all' は take なし (全件)。
  const sp = await searchParams;
  const limitParam: string = (ROLE_CHANGE_LIMIT_OPTIONS as readonly string[]).includes(sp.limit ?? '')
    ? (sp.limit as string)
    : DEFAULT_ROLE_CHANGE_LIMIT;
  const take = limitParam === 'all' ? undefined : Number(limitParam);

  // 2026-05-10 Phase 2-10: RoleChangeLog 直接 tenantId 列で絞込み (旧 targetUser join 経由から移行)。
  //   indexed lookup で高速、User 物理削除後の追従も可能。
  const logs = await prisma.roleChangeLog.findMany({
    where: { tenantId: session.user.tenantId },
    include: {
      changer: { select: { name: true } },
      targetUser: { select: { name: true, email: true } },
    },
    orderBy: { createdAt: 'desc' },
    ...(take != null ? { take } : {}),
  });

  // 2026-06-03: 種別・ロールをロケール/ラベル表示に変換 (内部コードのまま出さない)。
  const changeTypeLabel = (ct: string): string =>
    t.has(`changeTypeLabels.${ct}`) ? t(`changeTypeLabels.${ct}`) : ct;
  const roleLabel = (changeType: string, role: string | null): string => {
    if (role == null || role === '') return '';
    // active/inactive/deleted/removed 等のライフサイクル値 (ロール以外) を先に翻訳
    if (t.has(`roleStateLabels.${role}`)) return t(`roleStateLabels.${role}`);
    const map = (changeType === 'project_role' ? PROJECT_ROLES : SYSTEM_ROLES) as Record<string, string>;
    return map[role] ?? role;
  };

  // PR feat/sortable-columns: client component (sortable) に渡せるよう plain object に整形。
  const rows: RoleChangeRow[] = logs.map((log) => ({
    id: log.id,
    createdAtIso: log.createdAt.toISOString(),
    createdAtDisplay: formatDateTimeFull(log.createdAt.toISOString()),
    changerName: log.changer.name,
    targetUserName: log.targetUser.name,
    changeTypeDisplay: changeTypeLabel(log.changeType),
    beforeRoleDisplay: roleLabel(log.changeType, log.beforeRole),
    afterRoleDisplay: roleLabel(log.changeType, log.afterRole),
    reason: log.reason,
  }));

  return (
    <div className="space-y-6">
      <RoleChangesTable
        logs={rows}
        currentLimit={limitParam}
        limitOptions={[...ROLE_CHANGE_LIMIT_OPTIONS]}
        isCapped={take != null && logs.length >= take}
      />
    </div>
  );
}
