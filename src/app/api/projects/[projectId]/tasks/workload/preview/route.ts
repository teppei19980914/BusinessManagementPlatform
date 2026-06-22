/**
 * GET /api/projects/[projectId]/tasks/workload/preview (PR #361 / 2026-05-14)
 *
 * WBS 画面で ACT を作成・編集中に、担当者の日次工数が他タスクと合算してオーバー
 * しないかをリアルタイム表示するための preview API。
 *
 * Query パラメータ:
 *   - assigneeId: string  必須
 *   - startDate: 'YYYY-MM-DD'  必須
 *   - endDate: 'YYYY-MM-DD'    必須
 *   - plannedEffort: number    必須 (時間、0 以上)
 *   - excludeTaskId: string?   オプション (編集時の自タスク二重カウント防止)
 *
 * 認可: task:read (= データ閲覧レベル。create/update 権限は UI 側でゲート)
 * テナント分離: checkProjectPermission + service 層の `project.tenantId` フィルタで二重防御
 *
 * 関連:
 *   - サービス: src/services/task.service.ts:previewActivityWorkload
 *   - UI: src/components/wbs/workload-preview-line.tsx
 *   - hook: src/components/hooks/use-workload-preview.ts
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { getAuthenticatedUser, checkProjectPermission } from '@/lib/api-helpers';
import { previewActivityWorkload } from '@/services/task.service';

const querySchema = z.object({
  assigneeId: z.string().uuid({ message: 'assigneeId は UUID 形式である必要があります' }),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'startDate は YYYY-MM-DD 形式である必要があります',
  }),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'endDate は YYYY-MM-DD 形式である必要があります',
  }),
  plannedEffort: z.coerce.number().min(0, { message: 'plannedEffort は 0 以上である必要があります' }),
  excludeTaskId: z.string().uuid().optional(),
  includeWeekends: z.coerce.boolean().optional().default(false),
});

export const dynamic = 'force-dynamic';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { projectId } = await params;
  const forbidden = await checkProjectPermission(user, projectId, 'task:read');
  if (forbidden) return forbidden;

  const { searchParams } = new URL(req.url);
  const parsed = querySchema.safeParse({
    assigneeId: searchParams.get('assigneeId'),
    startDate: searchParams.get('startDate'),
    endDate: searchParams.get('endDate'),
    plannedEffort: searchParams.get('plannedEffort'),
    excludeTaskId: searchParams.get('excludeTaskId') ?? undefined,
    includeWeekends: searchParams.get('includeWeekends') ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', message: parsed.error.issues[0]?.message ?? 'Invalid query' } },
      { status: 400 },
    );
  }

  const data = await previewActivityWorkload({
    projectId,
    assigneeId: parsed.data.assigneeId,
    startDate: parsed.data.startDate,
    endDate: parsed.data.endDate,
    plannedEffort: parsed.data.plannedEffort,
    excludeTaskId: parsed.data.excludeTaskId,
    includeWeekends: parsed.data.includeWeekends,
    viewerTenantId: user.tenantId,
  });

  return NextResponse.json({ data });
}
