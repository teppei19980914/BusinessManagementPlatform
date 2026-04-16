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
  const count = await bulkUpdateTasks(projectId, taskIds, { assigneeId, priority }, user.id);

  await recordAuditLog({
    userId: user.id,
    action: 'UPDATE',
    entityType: 'task',
    entityId: taskIds.join(','),
    afterValue: { bulk: true, count, assigneeId, priority },
  });

  return NextResponse.json({ data: { updatedCount: count } });
}
