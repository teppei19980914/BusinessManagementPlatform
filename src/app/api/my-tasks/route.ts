/**
 * GET /api/my-tasks - ログイン中ユーザの担当タスク横断一覧
 *
 * 役割:
 *   マイタスク画面 (/my-tasks) のデータソース。assignee_id = 自分 のタスクを
 *   全プロジェクト横断で集約して返す。WP は assignee_id を持たないため対象外。
 *
 * 認可: getAuthenticatedUser (ログイン中ユーザ本人のみ自分のタスクが見える)
 *
 * 関連:
 *   - DESIGN.md §15 (idx_tasks_assignee インデックス)
 *   - SPECIFICATION.md (マイタスク画面)
 *   - PR #69 (マイタスク導線)
 */

import { NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { prisma } from '@/lib/db';

export async function GET() {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const tasks = await prisma.task.findMany({
    where: {
      assigneeId: user.id,
      type: 'activity',
      deletedAt: null,
      status: { not: 'completed' },
    },
    include: {
      project: { select: { name: true } },
    },
    orderBy: [{ plannedEndDate: 'asc' }, { priority: 'desc' }],
  });

  const data = tasks.map((t) => ({
    id: t.id,
    projectId: t.projectId,
    projectName: t.project.name,
    name: t.name,
    status: t.status,
    progressRate: t.progressRate,
    plannedStartDate: t.plannedStartDate!.toISOString().split('T')[0],
    plannedEndDate: t.plannedEndDate!.toISOString().split('T')[0],
    plannedEffort: Number(t.plannedEffort),
    priority: t.priority,
    isDelayed: t.plannedEndDate != null && new Date(t.plannedEndDate) < new Date() && t.status !== 'completed',
  }));

  return NextResponse.json({ data });
}
