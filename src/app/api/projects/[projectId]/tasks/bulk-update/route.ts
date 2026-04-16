import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser, checkProjectPermission } from '@/lib/api-helpers';
import { bulkUpdateTaskSchema } from '@/lib/validators/task';
import { bulkUpdateTasks } from '@/services/task.service';
import { recordAuditLog } from '@/services/audit.service';

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { projectId } = await params;
  const forbidden = await checkProjectPermission(user, projectId, 'task:update');
  if (forbidden) return forbidden;

  const body = await req.json();
  const parsed = bulkUpdateTaskSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', details: parsed.error.issues } },
      { status: 400 },
    );
  }

  const { taskIds, assigneeId, priority } = parsed.data;

  let count: number;
  try {
    count = await bulkUpdateTasks(projectId, taskIds, { assigneeId, priority }, user.id);
  } catch (e) {
    if (e instanceof Error && e.message === 'ASSIGNEE_NOT_MEMBER') {
      return NextResponse.json(
        { error: { code: 'VALIDATION_ERROR', message: '指定された担当者はプロジェクトメンバーではありません' } },
        { status: 400 },
      );
    }
    throw e;
  }

  await recordAuditLog({
    userId: user.id,
    action: 'UPDATE',
    entityType: 'task',
    entityId: `bulk:${count}`,
    afterValue: { bulk: true, count, taskIds, projectId, assigneeId, priority },
  });

  return NextResponse.json({ data: { updatedCount: count } });
}
