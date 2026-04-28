/**
 * GET  /api/projects/[id]/tasks/[taskId]/progress - 進捗ログ一覧取得
 * POST /api/projects/[id]/tasks/[taskId]/progress - 進捗ログ追加 (進捗率/実績工数の更新)
 *
 * 役割:
 *   タスクの進捗を時系列で記録する。POST 時にタスク本体の progress_rate /
 *   actual_effort も最新値に更新。WP は集約対象のため進捗ログは持たない (ACT のみ)。
 *
 * 認可: checkProjectPermission ('task:read' / 'task:update_progress')
 * 監査: POST 時に audit_logs (action=UPDATE, entityType=task) に進捗値を記録。
 *
 * 関連:
 *   - DESIGN.md §5 (テーブル定義: task_progress_logs)
 *   - PR #69 (進捗 100% ↔ 完了状態の双方向整合)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from 'next-intl/server';
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
    const t = await getTranslations('message');
    return NextResponse.json(
      { error: { code: 'NOT_FOUND', message: t('notFoundTarget') } },
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
    const t = await getTranslations('message');
    return NextResponse.json(
      { error: { code: 'NOT_FOUND', message: t('notFoundTarget') } },
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
