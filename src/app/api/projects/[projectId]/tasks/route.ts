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
import {
  getAuthenticatedUser,
  checkProjectPermission,
  requireStorageQuotaForWrite,
} from '@/lib/api-helpers';
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

  const tasks = await listTasksFlat(projectId, user.tenantId);
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

  // PR-5 (2026-05-15): ストレージ容量 Pre-check
  const quotaErr = await requireStorageQuotaForWrite(
    user.tenantId,
    JSON.stringify(parsed.data).length,
  );
  if (quotaErr) return quotaErr;

  let task;
  try {
    task = await createTask(projectId, parsed.data, user.id, user.tenantId);
  } catch (e) {
    // 2026-05-25 (PR #420 #C3): 同一親配下に同名タスクが既存 → 400 で user-friendly に返す
    if (e instanceof Error && e.message === 'TASK_NAME_DUPLICATE_IN_PARENT') {
      return NextResponse.json(
        {
          error: {
            code: 'TASK_NAME_DUPLICATE_IN_PARENT',
            message: '同じ親 WP の配下に同じ名称のタスクが既に存在します。名称を変えるか、別の親 WP を選択してください。',
          },
        },
        { status: 400 },
      );
    }
    throw e;
  }

  await recordAuditLog({
    tenantId: user.tenantId,
    userId: user.id,
    action: 'CREATE',
    entityType: 'task',
    entityId: task.id,
    afterValue: sanitizeForAudit(task as unknown as Record<string, unknown>),
  });

  return NextResponse.json({ data: task }, { status: 201 });
}
