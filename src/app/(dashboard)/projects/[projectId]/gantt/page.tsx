import { auth } from '@/lib/auth';
import { redirect, notFound } from 'next/navigation';
import { LOGIN_ROUTE } from '@/config';
import { checkMembership } from '@/lib/permissions';
import { listTasks } from '@/services/task.service';
import { listMembers } from '@/services/member.service';
import { GanttClient } from './gantt-client';

type Props = { params: Promise<{ projectId: string }> };

export default async function GanttPage({ params }: Props) {
  const session = await auth();
  if (!session) redirect(LOGIN_ROUTE);

  const { projectId } = await params;
  const membership = await checkMembership(projectId, session.user.id, session.user.systemRole);
  if (!membership.isMember) notFound();

  // GanttClient は WBS と同じ tree 構造を要求する（階層描画 + 担当者フィルタのため）
  const [tasks, members] = await Promise.all([
    listTasks(projectId),
    listMembers(projectId),
  ]);

  return <GanttClient projectId={projectId} tasks={tasks} members={members} />;
}
