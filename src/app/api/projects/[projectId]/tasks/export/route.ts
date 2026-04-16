import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser, checkProjectPermission } from '@/lib/api-helpers';
// エクスポートは task:create 権限（PM/TL以上）を要求
import { exportWbsTemplate } from '@/services/task.service';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { projectId } = await params;
  const forbidden = await checkProjectPermission(user, projectId, 'task:create');
  if (forbidden) return forbidden;

  const body = await req.json().catch(() => ({}));
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const taskIds: string[] | undefined = Array.isArray(body.taskIds)
    ? body.taskIds.filter((id: unknown): id is string => typeof id === 'string' && uuidRegex.test(id))
    : undefined;

  const csv = await exportWbsTemplate(projectId, taskIds);

  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="wbs-template.csv"`,
    },
  });
}
