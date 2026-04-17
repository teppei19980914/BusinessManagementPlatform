import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser, checkProjectPermission } from '@/lib/api-helpers';
import { updateTaskSchema } from '@/lib/validators/task';
import { getTask, updateTask, deleteTask } from '@/services/task.service';
import { recordAuditLog, sanitizeForAudit } from '@/services/audit.service';

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

  return NextResponse.json({ data: task });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string; taskId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { projectId, taskId } = await params;

  const body = await req.json();
  const parsed = updateTaskSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', details: parsed.error.issues } },
      { status: 400 },
    );
  }

  const before = await getTask(taskId);
  if (!before || before.projectId !== projectId) {
    return NextResponse.json(
      { error: { code: 'NOT_FOUND', message: '対象が見つかりません' } },
      { status: 404 },
    );
  }

  // 権限判定:
  // - task:update を持つロール（admin / pm_tl）は全フィールド更新可
  // - メンバーが自分の担当タスクを更新する場合は task:update_progress として扱い、
  //   進捗・実績系フィールドのみ更新を許可（他フィールドが混入していれば 403）
  const fullUpdateForbidden = await checkProjectPermission(user, projectId, 'task:update');
  if (fullUpdateForbidden) {
    const progressForbidden = await checkProjectPermission(
      user,
      projectId,
      'task:update_progress',
      before.assigneeId ?? undefined,
    );
    if (progressForbidden) return progressForbidden;

    // メンバーが更新できるフィールドを制限する（編集系が混入すれば拒否）
    const ALLOWED_FOR_MEMBER = new Set([
      'status',
      'progressRate',
      'actualStartDate',
      'actualEndDate',
    ]);
    const disallowedKeys = Object.keys(parsed.data).filter(
      (k) => !ALLOWED_FOR_MEMBER.has(k),
    );
    if (disallowedKeys.length > 0) {
      return NextResponse.json(
        {
          error: {
            code: 'FORBIDDEN',
            message: `担当者は実績系の項目のみ更新できます（不可: ${disallowedKeys.join(', ')}）`,
          },
        },
        { status: 403 },
      );
    }
  }

  const task = await updateTask(taskId, parsed.data, user.id);

  await recordAuditLog({
    userId: user.id,
    action: 'UPDATE',
    entityType: 'task',
    entityId: taskId,
    beforeValue: sanitizeForAudit(before as unknown as Record<string, unknown>),
    afterValue: sanitizeForAudit(task as unknown as Record<string, unknown>),
  });

  return NextResponse.json({ data: task });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ projectId: string; taskId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { projectId, taskId } = await params;
  const forbidden = await checkProjectPermission(user, projectId, 'task:delete');
  if (forbidden) return forbidden;

  const before = await getTask(taskId);
  if (!before || before.projectId !== projectId) {
    return NextResponse.json(
      { error: { code: 'NOT_FOUND', message: '対象が見つかりません' } },
      { status: 404 },
    );
  }

  await deleteTask(taskId, user.id);

  await recordAuditLog({
    userId: user.id,
    action: 'DELETE',
    entityType: 'task',
    entityId: taskId,
    beforeValue: sanitizeForAudit(before as unknown as Record<string, unknown>),
  });

  return NextResponse.json({ data: { success: true } });
}
