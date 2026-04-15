import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { prisma } from '@/lib/db';
import { MyTasksClient } from './my-tasks-client';

export default async function MyTasksPage() {
  const session = await auth();
  if (!session) redirect('/login');

  const tasks = await prisma.task.findMany({
    where: {
      assigneeId: session.user.id,
      deletedAt: null,
    },
    include: {
      project: { select: { name: true } },
    },
    orderBy: [{ status: 'asc' }, { plannedEndDate: 'asc' }],
  });

  const data = tasks.map((t) => ({
    id: t.id,
    projectId: t.projectId,
    projectName: t.project.name,
    name: t.name,
    status: t.status,
    progressRate: t.progressRate,
    plannedStartDate: t.plannedStartDate.toISOString().split('T')[0],
    plannedEndDate: t.plannedEndDate.toISOString().split('T')[0],
    plannedEffort: Number(t.plannedEffort),
    priority: t.priority,
    isDelayed: new Date(t.plannedEndDate) < new Date() && t.status !== 'completed',
  }));

  return <MyTasksClient tasks={data} />;
}
