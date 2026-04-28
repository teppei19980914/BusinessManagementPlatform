/**
 * GET /api/projects/[projectId]/retrospectives/export?mode=sync — 振り返り 16 列 CSV (T-22 Phase 22b)
 *
 * sync-import の往復編集に使う 13 列 full-fidelity 形式を出力する。
 * 認可: retrospective:update (上書き編集の準備)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser, checkProjectPermission } from '@/lib/api-helpers';
import { exportRetrospectivesSync } from '@/services/retrospective-sync-import.service';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { projectId } = await params;
  const forbidden = await checkProjectPermission(user, projectId, 'project:update');
  if (forbidden) return forbidden;

  const csv = await exportRetrospectivesSync(projectId, user.systemRole);

  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="retrospectives_sync_${projectId}.csv"`,
    },
  });
}
