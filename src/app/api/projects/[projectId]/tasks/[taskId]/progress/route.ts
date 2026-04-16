import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser, checkProjectPermission } from '@/lib/api-helpers';
import { updateProgressSchema } from '@/lib/validators/task';
import { getTask, updateTaskProgress, getProgressLogs } from '@/services/task.service';
import { recordAuditLog } from '@/services/audit.service';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ projectId: string; taskId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { projectId, taskId } = await params;
  const forbidden = await checkProjectPermission(user, projectId, 'task:read');
  if (forbidden) return forbidden;

  const task = await getTask(taskId);
  if (!task || task.projectId !== projectId) {
    return NextResponse.json(
      { error: { code: 'NOT_FOUND', message: '対象が見つかりません' } },
      { status: 404 },
    );
  }

  const logs = await getProgressLogs(taskId);
  return NextResponse.json({ data: logs });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string; taskId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { projectId, taskId } = await params;

  const task = await getTask(taskId);
  if (!task || task.projectId !== projectId) {
    return NextResponse.json(
      { error: { code: 'NOT_FOUND', message: '対象が見つかりません' } },
      { status: 404 },
    );
  }

  // 進捗更新: admin/pm_tl は全タスク、member は自分の担当タスクのみ
  const forbidden = await checkProjectPermission(
    user,
    projectId,
    'task:update_progress',
    task.assigneeId ?? undefined,
  );
  if (forbidden) return forbidden;

  const body = await req.json();
  const parsed = updateProgressSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', details: parsed.error.issues } },
      { status: 400 },
    );
  }

  await updateTaskProgress(taskId, parsed.data, user.id);

  await recordAuditLog({
    userId: user.id,
    action: 'UPDATE',
    entityType: 'task_progress',
    entityId: taskId,
    afterValue: { ...parsed.data },
  });

  return NextResponse.json({ data: { success: true } }, { status: 201 });
}
