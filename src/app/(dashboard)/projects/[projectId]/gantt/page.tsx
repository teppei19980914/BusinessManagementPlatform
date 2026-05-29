import { auth } from '@/lib/auth';
import { redirect, notFound } from 'next/navigation';
import { LOGIN_ROUTE } from '@/config';
import { checkMembership } from '@/lib/permissions';
import { listTasks } from '@/services/task.service';
import { listMembers } from '@/services/member.service';
import { getTenantTodayString } from '@/lib/tenant-time';
import { resolveTimezone, resolveLocale } from '@/config/i18n';
import { GanttClient } from './gantt-client';

type Props = { params: Promise<{ projectId: string }> };

export default async function GanttPage({ params }: Props) {
  const session = await auth();
  if (!session) redirect(LOGIN_ROUTE);

  const { projectId } = await params;
  const membership = await checkMembership(projectId, session.user.id, session.user.systemRole, session.user.tenantId);
  if (!membership.isMember) notFound();

  // GanttClient は WBS と同じ tree 構造を要求する（階層描画 + 担当者フィルタのため）
  const [tasks, members] = await Promise.all([
    listTasks(projectId, session.user.tenantId),
    listMembers(projectId, session.user.tenantId),
  ]);

  // feat/gantt-initial-scroll-and-locale: Tenant TZ ベースの today と locale を server で確定し、
  //   client での new Date() による hydration mismatch および UTC ズレを回避する。
  const tenantTimeZone = resolveTimezone(session.user.timezone);
  const tenantLocale = resolveLocale(session.user.locale);
  const today = getTenantTodayString(new Date(), tenantTimeZone);

  return (
    <GanttClient
      projectId={projectId}
      tasks={tasks}
      members={members}
      today={today}
      tenantTimeZone={tenantTimeZone}
      tenantLocale={tenantLocale}
    />
  );
}
