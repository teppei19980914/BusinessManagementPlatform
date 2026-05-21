/**
 * POST /api/projects/[projectId]/tasks/bulk-duplicate - WBS タスク一括複製 (PR #420 2026-05-25)
 *
 * 役割:
 *   WBS 画面でチェック ON のタスクを「target parent (= 任意 WP or root)」配下に
 *   そのままの構造で複製する。インポート手順を経ずに画面上で複数作成する導線。
 *
 * 認可:
 *   task:update (= PM/TL + admin) を要求。一括編集と同じレベル。
 *
 * 監査:
 *   各 created task ごとに audit_logs を 1 件追加。
 *
 * 関連:
 *   - src/services/task-duplicate.service.ts (本体ロジック)
 *   - SPECIFICATION.md WBS 一括複製仕様 (本 PR で追加予定)
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { getAuthenticatedUser, checkProjectPermission } from '@/lib/api-helpers';
import { duplicateTasks, MAX_DUPLICATE_AT_ONCE } from '@/services/task-duplicate.service';
import { recordAuditLog } from '@/services/audit.service';
import { logUnknownError } from '@/services/error-log.service';

export const runtime = 'nodejs';

const bodySchema = z.object({
  taskIds: z.array(z.string().uuid()).min(1).max(MAX_DUPLICATE_AT_ONCE),
  targetParentId: z.string().uuid().nullable(),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { projectId } = await params;

  // 認可: 一括編集と同じレベル (PM/TL + admin)
  const forbidden = await checkProjectPermission(user, projectId, 'task:update');
  if (forbidden) return forbidden;

  const body = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', details: parsed.error.issues } },
      { status: 400 },
    );
  }

  const { taskIds, targetParentId } = parsed.data;

  try {
    const result = await duplicateTasks({
      projectId,
      taskIds,
      targetParentId,
      userId: user.id,
      viewerTenantId: user.tenantId,
    });

    // 監査: 一括操作のため、操作単位で 1 件 + 作成タスクごとに 1 件記録 (audit-trail 完備)
    await recordAuditLog({
      tenantId: user.tenantId,
      userId: user.id,
      action: 'BULK_DUPLICATE',
      entityType: 'task',
      entityId: projectId,
      afterValue: {
        targetParentId,
        sourceTaskIds: taskIds,
        added: result.added,
        renamedCount: result.renamedCount,
        createdIds: result.createdIds,
      },
    });

    return NextResponse.json({ data: result }, { status: 200 });
  } catch (e) {
    if (e instanceof Error) {
      // 各種 service 層エラーを 400 に変換
      const code = e.message.split(':')[0];
      const userFacingCodes = new Set([
        'TASKS_OUT_OF_RANGE',
        'PROJECT_NOT_FOUND',
        'TASKS_NOT_FOUND',
        'TASKS_CROSS_PROJECT',
        'TARGET_PARENT_NOT_FOUND',
        'TARGET_PARENT_NOT_WP',
        'ACT_CANNOT_BE_ROOT',
      ]);
      if (userFacingCodes.has(code)) {
        return NextResponse.json(
          { error: { code, message: e.message } },
          { status: code === 'PROJECT_NOT_FOUND' || code === 'TARGET_PARENT_NOT_FOUND' ? 404 : 400 },
        );
      }
    }

    await logUnknownError('server', e, {
      userId: user.id,
      context: { path: 'POST /api/projects/[id]/tasks/bulk-duplicate', taskIds, targetParentId },
    });
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: '一括複製に失敗しました' } },
      { status: 500 },
    );
  }
}
