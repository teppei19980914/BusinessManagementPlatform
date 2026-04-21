/**
 * PATCH /api/projects/[projectId]/tasks/bulk-update - タスク一括更新
 *
 * 役割:
 *   WBS 画面のチェックボックス選択 + 一括編集パネルから複数タスクを 1 リクエストで
 *   更新する (担当者 / 期限 / ステータス等)。N タスクに対して N 回 API を叩くと
 *   遅いため bulk 化したエンドポイント。
 *
 * 認可 (PR #85 で動的化):
 *   更新内容によって要求する権限を切り替える。
 *   - 「実績系のみ」 (status / progressRate / actualStartDate / actualEndDate) の場合は
 *      `task:update_progress` で通過可 (= member ロールでも自分担当のタスクだけ一括可)
 *   - 「計画系を含む」 (assigneeId / priority / plannedStartDate / plannedEndDate /
 *      plannedEffort) の場合は `task:update` が必要 (= pm_tl / admin のみ)
 *   旧実装では常に `task:update` を要求していたため、member ロールは一括更新を
 *   一切使えず、WBS で自分担当タスクの進捗だけまとめて更新することが不可能だった。
 *
 * 監査: 各タスクごとに audit_logs に before/after を記録 (recordBulkAuditLogs)。
 *
 * 関連:
 *   - DESIGN.md §17 (パフォーマンス要件 / N+1 回避)
 *   - DESIGN.md §8 (権限制御 — task:update vs task:update_progress の使い分け)
 *   - SPECIFICATION.md (WBS 一括編集パネル)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser, checkProjectPermission } from '@/lib/api-helpers';
import { bulkUpdateTaskSchema } from '@/lib/validators/task';
import { bulkUpdateTasks } from '@/services/task.service';
import { recordBulkAuditLogs } from '@/services/audit.service';
import { prisma } from '@/lib/db';

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { projectId } = await params;

  const body = await req.json();
  const parsed = bulkUpdateTaskSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', details: parsed.error.issues } },
      { status: 400 },
    );
  }

  const { taskIds, ...updates } = parsed.data;

  // 更新内容が「実績系フィールドのみ」かどうかを判定。
  // これが true のときは task:update_progress 権限でも通す (member ロール救済)。
  const hasPlanEdit
    = updates.assigneeId !== undefined
    || updates.priority !== undefined
    || updates.plannedStartDate !== undefined
    || updates.plannedEndDate !== undefined
    || updates.plannedEffort !== undefined;
  const requiredAction = hasPlanEdit ? 'task:update' : 'task:update_progress';

  const forbidden = await checkProjectPermission(user, projectId, requiredAction);
  if (forbidden) return forbidden;

  // member ロールが task:update_progress で通る場合は「自分担当のタスクのみ」制約を
  // bulk 対象に適用する。admin / pm_tl は本チェックをバイパス (単体 task:update_progress
  // を resourceOwnerId 無しで許可する現行の check-permission ロジックと揃える)。
  if (!hasPlanEdit && user.systemRole !== 'admin') {
    const membership = await prisma.projectMember.findFirst({
      where: { projectId, userId: user.id },
      select: { projectRole: true },
    });
    if (membership?.projectRole === 'member') {
      const others = await prisma.task.findMany({
        where: {
          id: { in: taskIds },
          projectId,
          deletedAt: null,
          // 自分が担当でないタスクを 1 件でも含むなら弾く
          NOT: { assigneeId: user.id },
        },
        select: { id: true },
      });
      if (others.length > 0) {
        return NextResponse.json(
          {
            error: {
              code: 'FORBIDDEN',
              message: '一括進捗更新は自分が担当のタスクのみ対象にできます',
            },
          },
          { status: 403 },
        );
      }
    }
  }

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
