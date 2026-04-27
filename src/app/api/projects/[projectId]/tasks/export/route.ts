/**
 * POST /api/projects/[projectId]/tasks/export - WBS エクスポート (CSV)
 *
 * 役割:
 *   現プロジェクトの WBS 構造を CSV としてダウンロード。2 モードあり:
 *     - mode='template' (既定、後方互換): 別プロジェクトへの雛形流用、10 列、担当者・進捗リセット
 *     - mode='sync' (feat/wbs-overwrite-import): 同一プロジェクト上書き編集、17 列、ID + 担当者 + 進捗系含む
 *
 * 認可:
 *   template: checkProjectPermission('task:create') — 新規作成相当
 *   sync: checkProjectPermission('task:update') — 上書き編集の準備として update 権限
 *
 * 関連: SPECIFICATION.md (WBS テンプレート機能 / WBS 上書きインポート仕様)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser, checkProjectPermission } from '@/lib/api-helpers';
import { exportWbsTemplate, type WbsExportMode } from '@/services/task.service';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { projectId } = await params;

  const body = await req.json().catch(() => ({}));
  const mode: WbsExportMode = body?.mode === 'sync' ? 'sync' : 'template';

  // mode によって要求権限を切り替え
  const forbidden = await checkProjectPermission(
    user,
    projectId,
    mode === 'sync' ? 'task:update' : 'task:create',
  );
  if (forbidden) return forbidden;

  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const taskIds: string[] | undefined = Array.isArray(body.taskIds)
    ? body.taskIds.filter((id: unknown): id is string => typeof id === 'string' && uuidRegex.test(id))
    : undefined;

  const csv = await exportWbsTemplate(projectId, taskIds, mode);

  const filename = mode === 'sync' ? 'wbs-sync.csv' : 'wbs-template.csv';
  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
}
