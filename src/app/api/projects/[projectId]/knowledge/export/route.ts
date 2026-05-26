/**
 * POST /api/projects/[projectId]/knowledge/export — ナレッジ CSV (T-22 Phase 22c)
 *
 * fix/list-export-import-bugs (2026-05-26):
 *   - GET → POST に変更し body で ids を受け取れるように (tasks /export と統一)
 *   - body.ids が指定されればその ID のみ export、未指定なら全件 (従来挙動)
 *
 * 認可: knowledge:read
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser, checkProjectPermission } from '@/lib/api-helpers';
import { exportKnowledgeSync } from '@/services/knowledge-sync-import.service';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { projectId } = await params;
  const forbidden = await checkProjectPermission(user, projectId, 'knowledge:read');
  if (forbidden) return forbidden;

  // body.ids は省略可能。未指定または空配列なら全件 export (従来挙動)
  let ids: string[] | undefined;
  try {
    const body = await req.json().catch(() => ({}));
    if (Array.isArray(body?.ids) && body.ids.length > 0) {
      ids = body.ids.filter((x: unknown): x is string => typeof x === 'string');
    }
  } catch {
    // 空 body は許容 (= 全件)
  }

  // feat/crud-permission-redesign (2026-05-20): viewer の userId/systemRole を渡して
  //   visibility フィルタを適用 (非 admin は他人 draft 除外)。severity-1 漏洩修正。
  const csv = await exportKnowledgeSync(projectId, user.tenantId, user.id, user.systemRole, ids);
  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="knowledge_sync_${projectId}.csv"`,
    },
  });
}
