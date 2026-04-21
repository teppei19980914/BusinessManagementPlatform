/**
 * PATCH /api/projects/[projectId]/tasks/bulk-update - タスク一括更新
 *
 * 役割:
 *   WBS 画面のチェックボックス選択 + 一括編集パネルから複数タスクを 1 リクエストで
 *   更新する (担当者 / 期限 / ステータス等)。N タスクに対して N 回 API を叩くと
 *   遅いため bulk 化したエンドポイント。
 *
 * 認可: checkProjectPermission('task:edit')
 * 監査: 各タスクごとに audit_logs に before/after を記録 (recordBulkAuditLogs)。
 *
 * 関連:
 *   - DESIGN.md §17 (パフォーマンス要件 / N+1 回避)
 *   - SPECIFICATION.md (WBS 一括編集パネル)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser, checkProjectPermission } from '@/lib/api-helpers';
import { bulkUpdateTaskSchema } from '@/lib/validators/task';
import { bulkUpdateTasks } from '@/services/task.service';
import { recordBulkAuditLogs } from '@/services/audit.service';

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

  const { taskIds, ...updates } = parsed.data;

  let count: number;
  try {
    count = await bulkUpdateTasks(projectId, taskIds, updates, user.id);
  } catch (e) {
    if (e instanceof Error && e.message === 'ASSIGNEE_NOT_MEMBER') {
      return NextResponse.json(
        { error: { code: 'VALIDATION_ERROR', message: '指定された担当者はプロジェクトメンバーではありません' } },
        { status: 400 },
      );
    }
    throw e;
  }

  // 監査ログは「タスクごとに 1 行」で記録する。
  // 以前は entityId に `bulk:${count}` のような合成文字列を入れていたが、
  // AuditLog.entityId は @db.Uuid 型のため P2007 エラーになり一括更新全体が 500 になっていた。
  await recordBulkAuditLogs({
    userId: user.id,
    action: 'UPDATE',
    entityType: 'task',
    entityIds: taskIds,
    afterValue: { bulk: true, bulkRequestSize: taskIds.length, bulkUpdatedCount: count, projectId, updates },
  });

  return NextResponse.json({ data: { updatedCount: count } });
}
