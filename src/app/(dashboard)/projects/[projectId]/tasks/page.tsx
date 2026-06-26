import { auth } from '@/lib/auth';
import { redirect, notFound } from 'next/navigation';
import { LOGIN_ROUTE } from '@/config';
import { checkMembership } from '@/lib/permissions';
import { listTasks } from '@/services/task.service';
import { listMembers } from '@/services/member.service';
import { getTenantTodayString } from '@/lib/tenant-time';
import { resolveTimezone } from '@/config/i18n';
import { TasksClient } from './tasks-client';

type Props = {
  params: Promise<{ projectId: string }>;
};

export default async function TasksPage({ params }: Props) {
  const session = await auth();
  if (!session) redirect(LOGIN_ROUTE);

  const { projectId } = await params;

  const membership = await checkMembership(projectId, session.user.id, session.user.systemRole, session.user.tenantId);
  if (!membership.isMember) notFound();

  const tenantTimeZone = resolveTimezone(session.user.timezone);
  const today = getTenantTodayString(new Date(), tenantTimeZone);

  const [tasks, members] = await Promise.all([
    listTasks(projectId, session.user.tenantId),
    listMembers(projectId, session.user.tenantId),
  ]);

  return (
    <TasksClient
      projectId={projectId}
      tasks={tasks}
      members={members}
      projectRole={membership.projectRole}
      systemRole={session.user.systemRole}
      userId={session.user.id}
      today={today}
    />
  );
}
