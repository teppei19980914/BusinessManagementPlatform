/**
 * POST /api/projects/[projectId]/tasks/export - WBS エクスポート (7 列 CSV、T-19)
 *
 * 役割:
 *   現プロジェクトの WBS 構造を 7 列 CSV としてダウンロード
 *   (ID / 種別 / 名称 / レベル / 予定開始日 / 予定終了日 / 予定工数)。
 *   CSV 編集 → 上書きインポート (sync-import) の往復編集サイクルで使用。
 *
 * 認可: checkProjectPermission('task:update') — 上書き編集の準備として update 権限を要求
 *
 * 関連: SPECIFICATION.md (WBS 上書きインポート仕様), DESIGN.md §33
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser, checkProjectPermission } from '@/lib/api-helpers';
import { exportWbs } from '@/services/task.service';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { projectId } = await params;

  const forbidden = await checkProjectPermission(user, projectId, 'task:update');
  if (forbidden) return forbidden;

  const body = await req.json().catch(() => ({}));
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const taskIds: string[] | undefined = Array.isArray(body.taskIds)
    ? body.taskIds.filter((id: unknown): id is string => typeof id === 'string' && uuidRegex.test(id))
    : undefined;

  const csv = await exportWbs(projectId, taskIds);

  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="wbs.csv"',
    },
  });
}
