/**
 * GET /api/projects/[projectId]/knowledge/export — ナレッジ 14 列 CSV (T-22 Phase 22c)
 *
 * 認可: knowledge:read
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser, checkProjectPermission } from '@/lib/api-helpers';
import { exportKnowledgeSync } from '@/services/knowledge-sync-import.service';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { projectId } = await params;
  const forbidden = await checkProjectPermission(user, projectId, 'knowledge:read');
  if (forbidden) return forbidden;

  const csv = await exportKnowledgeSync(projectId);
  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="knowledge_sync_${projectId}.csv"`,
    },
  });
}
