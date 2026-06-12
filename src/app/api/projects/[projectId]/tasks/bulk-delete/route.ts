/**
 * POST /api/projects/[projectId]/tasks/bulk-delete - タスク一括論理削除 (ADR-0035)
 *
 * 役割:
 *   WBS 画面のチェックボックス選択から複数タスクを 1 リクエストでまとめて論理削除する。
 *   旧実装はクライアントが ID ごとに `DELETE /tasks/[taskId]` を逐次送信しており、
 *   1 件あたり ~9 回の DB 往復 (認証/権限/getTask/所有確認/transaction/recalc/audit) を
 *   件数分くり返して極端に遅かった。本エンドポイントは認証/権限を 1 回に集約し、
 *   所有確認 + 一括 soft-delete + 監査ログを最小往復で実行する。
 *
 * 認可: checkProjectPermission('task:delete') (admin / pm_tl)。
 *   task:delete 保持ロールは task:update も持つため、クライアントは全チャンク完了後に
 *   `POST /tasks/recalculate` (task:update) を 1 回呼んで WP 集計を再計算できる。
 *
 * 件数上限 (DoS 安全弁):
 *   クライアントは K=100 件ずつチャンク送信するが、API 直叩きの暴走を防ぐため
 *   1 リクエスト 200 件超は 413 で弾く (ADR-0032 の TASK_SYNC_IMPORT_MAX_ROWS と同思想)。
 *
 * 監査: タスクごとに 1 行 (recordBulkAuditLogs / createMany)。entityId は @db.Uuid のため
 *   合成文字列は使わず実 UUID を入れる (bulk-update と同じパターン)。
 *
 * 関連: ADR-0035 / docs/design/API_DESIGN.md
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser, checkProjectPermission } from '@/lib/api-helpers';
import { bulkDeleteTaskSchema } from '@/lib/validators/task';
import { bulkDeleteTasks } from '@/services/task.service';
import { recordBulkAuditLogs } from '@/services/audit.service';

/** 1 リクエストで受け付ける最大件数 (DoS 安全弁)。クライアントの chunkSize=100 の倍を上限に。 */
const TASK_BULK_DELETE_MAX = 200;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { projectId } = await params;
  const forbidden = await checkProjectPermission(user, projectId, 'task:delete');
  if (forbidden) return forbidden;

  const body = await req.json();
  const parsed = bulkDeleteTaskSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', details: parsed.error.issues } },
      { status: 400 },
    );
  }

  const { taskIds } = parsed.data;

  // DoS 安全弁: schema の max(200) と二重防御。超過は 413 で明示。
  if (taskIds.length > TASK_BULK_DELETE_MAX) {
    return NextResponse.json(
      {
        error: {
          code: 'PAYLOAD_TOO_LARGE',
          message: `一括削除は 1 回 ${TASK_BULK_DELETE_MAX} 件までです。分割して実行してください。`,
          limit: TASK_BULK_DELETE_MAX,
        },
      },
      { status: 413 },
    );
  }

  const { deletedCount, deletedIds } = await bulkDeleteTasks(
    projectId,
    taskIds,
    user.id,
    user.tenantId,
  );

  // 監査ログ: 実際に削除した UUID ごとに 1 行。
  if (deletedIds.length > 0) {
    await recordBulkAuditLogs({
      tenantId: user.tenantId,
      userId: user.id,
      action: 'DELETE',
      entityType: 'task',
      entityIds: deletedIds,
      afterValue: {
        bulk: true,
        bulkRequestSize: taskIds.length,
        bulkDeletedCount: deletedCount,
        projectId,
      },
    });
  }

  return NextResponse.json({ data: { deletedCount } });
}
