import { NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { prisma } from '@/lib/db';

export async function GET() {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const tasks = await prisma.task.findMany({
    where: {
      assigneeId: user.id,
      type: 'activity',
      deletedAt: null,
      status: { not: 'completed' },
    },
    include: {
      project: { select: { name: true } },
    },
    orderBy: [{ plannedEndDate: 'asc' }, { priority: 'desc' }],
  });

  const data = tasks.map((t) => ({
    id: t.id,
    projectId: t.projectId,
    projectName: t.project.name,
    name: t.name,
    status: t.status,
    progressRate: t.progressRate,
    plannedStartDate: t.plannedStartDate!.toISOString().split('T')[0],
    plannedEndDate: t.plannedEndDate!.toISOString().split('T')[0],
    plannedEffort: Number(t.plannedEffort),
    priority: t.priority,
    isDelayed: t.plannedEndDate != null && new Date(t.plannedEndDate) < new Date() && t.status !== 'completed',
  }));

  return NextResponse.json({ data });
}
