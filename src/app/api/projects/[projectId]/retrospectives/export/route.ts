/**
 * POST /api/projects/[projectId]/retrospectives/export?mode=sync — 振り返り CSV (T-22 Phase 22b)
 *
 * fix/list-export-import-bugs (2026-05-26):
 *   - GET → POST に変更し body で ids を受け取れるように (tasks /export と統一)
 *   - body.ids が指定されればその ID のみ export、未指定なら全件 (従来挙動)
 *
 * 認可: project:update (上書き編集の準備)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser, checkProjectPermission } from '@/lib/api-helpers';
import { exportRetrospectivesSync } from '@/services/retrospective-sync-import.service';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { projectId } = await params;
  const forbidden = await checkProjectPermission(user, projectId, 'project:update');
  if (forbidden) return forbidden;

  let ids: string[] | undefined;
  try {
    const body = await req.json().catch(() => ({}));
    if (Array.isArray(body?.ids) && body.ids.length > 0) {
      ids = body.ids.filter((x: unknown): x is string => typeof x === 'string');
    }
  } catch {
    // 空 body は許容 (= 全件)
  }

  const csv = await exportRetrospectivesSync(projectId, user.systemRole, user.tenantId, ids);

  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="retrospectives_sync_${projectId}.csv"`,
    },
  });
}
