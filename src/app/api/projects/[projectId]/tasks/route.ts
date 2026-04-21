/**
 * GET  /api/projects/[projectId]/tasks - 平坦タスク一覧取得 (WP/ACT 区別なし)
 * POST /api/projects/[projectId]/tasks - タスク新規作成 (WP または ACT)
 *
 * 役割:
 *   タスク一覧 (WBS 管理画面) のデータソース。階層ツリーが必要な画面は
 *   /tasks/tree (別エンドポイント) を使う。本エンドポイントは平坦リスト用。
 *
 * 認可: checkProjectPermission ('task:read' / 'task:create')
 * 監査: POST 時に audit_logs (action=CREATE, entityType=task) を記録。
 *
 * 関連: DESIGN.md §5 (テーブル定義: tasks - WP/ACT 階層)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser, checkProjectPermission } from '@/lib/api-helpers';
import { createTaskSchema } from '@/lib/validators/task';
import { listTasksFlat, createTask } from '@/services/task.service';
import { recordAuditLog, sanitizeForAudit } from '@/services/audit.service';

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
  return NextResponse.json({ data: tasks });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { projectId } = await params;
  const forbidden = await checkProjectPermission(user, projectId, 'task:create');
  if (forbidden) return forbidden;

  const body = await req.json();
  const parsed = createTaskSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', details: parsed.error.issues } },
      { status: 400 },
    );
  }

  const task = await createTask(projectId, parsed.data, user.id);

  await recordAuditLog({
    userId: user.id,
    action: 'CREATE',
    entityType: 'task',
    entityId: task.id,
    afterValue: sanitizeForAudit(task as unknown as Record<string, unknown>),
  });

  return NextResponse.json({ data: task }, { status: 201 });
}
