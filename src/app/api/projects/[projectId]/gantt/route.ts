import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser, checkProjectPermission } from '@/lib/api-helpers';
import { listTasksFlat } from '@/services/task.service';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { projectId } = await params;
  const forbidden = await checkProjectPermission(user, projectId, 'task:read');
  if (forbidden) return forbidden;

  const tasks = await listTasksFlat(projectId);

  // ガント用にデータ変換
  const ganttData = tasks.map((t) => ({
    id: t.id,
    name: t.name,
    assigneeName: t.assigneeName,
    startDate: t.plannedStartDate,
    endDate: t.plannedEndDate,
    progressRate: t.progressRate,
    status: t.status,
    isMilestone: t.isMilestone,
    parentTaskId: t.parentTaskId,
  }));

  return NextResponse.json({ data: ganttData });
}
