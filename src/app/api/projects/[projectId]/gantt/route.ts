/**
 * GET /api/projects/[projectId]/gantt - ガントチャート用タスク一覧取得
 *
 * 役割:
 *   ガントチャート画面のデータソース。WBS ツリーを構築する必要がないため
 *   listTasksFlat で平坦リストを返し、クライアント側で時系列描画する。
 *
 * 認可: checkProjectPermission('task:read')
 *
 * 関連:
 *   - DESIGN.md §15 (idx_tasks_gantt インデックス)
 *   - SPECIFICATION.md (ガントチャート画面)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser, checkProjectPermission } from '@/lib/api-helpers';
import { listTasksFlat } from '@/services/task.service';

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

  // ガント用にデータ変換
  const ganttData = tasks.map((t) => ({
    id: t.id,
    name: t.name,
    assigneeName: t.assigneeName,
    startDate: t.plannedStartDate,
    endDate: t.plannedEndDate,
    progressRate: t.progressRate,
    status: t.status,
    isMilestone: t.isMilestone,
    parentTaskId: t.parentTaskId,
  }));

  return NextResponse.json({ data: ganttData });
}
