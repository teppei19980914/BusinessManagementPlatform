import { auth } from '@/lib/auth';
import { redirect, notFound } from 'next/navigation';
import { checkMembership } from '@/lib/permissions';
import { listTasksFlat } from '@/services/task.service';
import { GanttClient } from './gantt-client';

type Props = { params: Promise<{ projectId: string }> };

export default async function GanttPage({ params }: Props) {
  const session = await auth();
  if (!session) redirect('/login');

  const { projectId } = await params;
  const membership = await checkMembership(projectId, session.user.id, session.user.systemRole);
  if (!membership.isMember) notFound();

  const tasks = await listTasksFlat(projectId);

  return <GanttClient projectId={projectId} tasks={tasks} />;
}
