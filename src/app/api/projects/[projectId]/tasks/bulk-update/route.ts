/**
 * PATCH /api/projects/[projectId]/tasks/bulk-update - タスク一括更新
 *
 * 役割:
 *   WBS 画面のチェックボックス選択 + 一括編集パネルから複数タスクを 1 リクエストで
 *   更新する (担当者 / 期限 / ステータス等)。N タスクに対して N 回 API を叩くと
 *   遅いため bulk 化したエンドポイント。
 *
 * 認可 (PR #85 で動的化 / PR #88 で担当者制約を全ロールに拡大):
 *   更新内容によって要求する権限を切り替える。
 *   - 「実績系のみ」 (status / progressRate / actualStartDate / actualEndDate) の場合は
 *      `task:update_progress` で通過可、**かつ対象タスクが全て自分担当であること**
 *      (admin / pm_tl を含む全ロールに適用 — 業務上「実績は担当者が記録する」原則)
 *   - 「計画系を含む」 (assigneeId / priority / plannedStartDate / plannedEndDate /
 *      plannedEffort) の場合は `task:update` が必要 (= pm_tl / admin のみ)
 *   旧実装 (PR #85) では member のみ担当者制約を適用し、admin / pm_tl はバイパス
 *   していたが、個別編集画面の実績項目も担当者のみに揃える修正 (PR #88) と整合させた。
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

  // PR #88: 実績系の一括更新は「全ロールで担当者本人のみ」の制約を適用する。
  // 旧実装 (PR #85) では admin / pm_tl をバイパスしていたが、業務上「実績は担当者が
  // 記録するもの」という原則に揃えるため、admin / pm_tl も他人担当タスクの実績系
  // 一括更新はできない。個別編集ダイアログ (tasks-client.tsx editingCanUpdateActual)
  // も同時に同じルールに変更している。
  //
  // 計画系 (task:update) の場合は従来どおり PM/TL 以上で自由 (アサイン変更は
  // PM/TL の業務権限)。
  if (!hasPlanEdit) {
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
            message: '一括実績更新は自分が担当のタスクのみ対象にできます',
          },
        },
        { status: 403 },
      );
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
