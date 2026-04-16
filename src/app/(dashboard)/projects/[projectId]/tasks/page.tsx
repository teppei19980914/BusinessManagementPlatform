import { auth } from '@/lib/auth';
import { redirect, notFound } from 'next/navigation';
import { checkMembership } from '@/lib/permissions';
import { listTasks } from '@/services/task.service';
import { listMembers } from '@/services/member.service';
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

  const [tasks, members] = await Promise.all([
    listTasks(projectId),
    listMembers(projectId),
  ]);

  return (
    <TasksClient
      projectId={projectId}
      tasks={tasks}
      members={members}
      projectRole={membership.projectRole}
      systemRole={session.user.systemRole}
      userId={session.user.id}
    />
  );
}
