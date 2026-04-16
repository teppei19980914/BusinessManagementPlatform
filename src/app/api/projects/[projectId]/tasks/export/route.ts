import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser, checkProjectPermission } from '@/lib/api-helpers';
import { exportWbsTemplate } from '@/services/task.service';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { projectId } = await params;
  const forbidden = await checkProjectPermission(user, projectId, 'task:read');
  if (forbidden) return forbidden;

  const body = await req.json().catch(() => ({}));
  const taskIds: string[] | undefined = Array.isArray(body.taskIds) ? body.taskIds : undefined;

  const template = await exportWbsTemplate(projectId, taskIds);

  return NextResponse.json({ data: template });
}
