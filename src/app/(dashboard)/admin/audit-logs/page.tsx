import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { prisma } from '@/lib/db';
// PR #117 → PR #119: session 連携フォーマッタ (ユーザ個別 TZ/locale を反映)
import { getServerFormatters } from '@/lib/server-formatters';
import { AuditLogsTable, type AuditLogRow } from './audit-logs-table';

export default async function AuditLogsPage() {
  const session = await auth();
  if (!session || session.user.systemRole !== 'admin') redirect('/');

  const t = await getTranslations('admin.auditLogs');
  const { formatDateTimeFull } = await getServerFormatters();

  // 2026-05-09 feedback: severity-1 テナント越境対策。
  //   旧仕様では他テナントの全 audit_log (誰がいつ何の entity を CRUD したか) が
  //   テナント A の admin に閲覧可能だった。AuditLog は tenantId 列を持たないため
  //   user リレーション経由で自テナント限定する。
  const logs = await prisma.auditLog.findMany({
    where: { user: { tenantId: session.user.tenantId } },
    include: { user: { select: { name: true } } },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });

  // PR feat/sortable-columns: client component (sortable) に渡せるよう plain object に整形。
  // formatDateTimeFull は session TZ を参照するため server 側で実行する必要がある。
  const rows: AuditLogRow[] = logs.map((log) => ({
    id: log.id,
    createdAtIso: log.createdAt.toISOString(),
    createdAtDisplay: formatDateTimeFull(log.createdAt.toISOString()),
    userName: log.user.name,
    action: log.action,
    entityType: log.entityType,
    entityId: log.entityId,
  }));

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-semibold">{t('title')}</h2>
      <AuditLogsTable logs={rows} />
    </div>
  );
}
