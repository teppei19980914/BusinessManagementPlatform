import { auth } from '@/lib/auth';
import { redirect, notFound } from 'next/navigation';
import { checkMembership } from '@/lib/permissions';
import { listTasks } from '@/services/task.service';
import { listMembers } from '@/services/member.service';
import { prisma } from '@/lib/db';
import { TasksClient } from './tasks-client';

type Props = {
  params: Promise<{ projectId: string }>;
};

export default async function TasksPage({ params }: Props) {
  const session = await auth();
  if (!session) redirect('/login');

  const { projectId } = await params;

  const membership = await checkMembership(projectId, session.user.id, session.user.systemRole);
  if (!membership.isMember) notFound();

  const canEdit = session.user.systemRole === 'admin' || membership.projectRole === 'pm_tl';

  const [tasks, members, allProjectsRaw] = await Promise.all([
    listTasks(projectId),
    listMembers(projectId),
    canEdit ? prisma.project.findMany({ where: { deletedAt: null }, select: { id: true, name: true }, orderBy: { name: 'asc' } }) : Promise.resolve([]),
  ]);

  return (
    <TasksClient
      projectId={projectId}
      tasks={tasks}
      members={members}
      allProjects={allProjectsRaw.map((p) => ({ id: p.id, name: p.name }))}
      projectRole={membership.projectRole}
      systemRole={session.user.systemRole}
      userId={session.user.id}
    />
  );
}
