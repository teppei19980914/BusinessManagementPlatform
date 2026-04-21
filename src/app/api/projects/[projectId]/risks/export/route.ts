/**
 * GET /api/projects/[projectId]/risks/export - リスク/課題 CSV エクスポート
 *
 * 役割:
 *   プロジェクトのリスク・課題一覧を CSV 形式でダウンロードできるようにする。
 *   PMO 報告書や監査資料への貼付用途。
 *
 * 認可: checkProjectPermission('risk:read')
 *
 * 関連: SPECIFICATION.md (リスク・課題管理 / CSV エクスポート)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser, checkProjectPermission } from '@/lib/api-helpers';
import { listRisks, risksToCSV } from '@/services/risk.service';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { projectId } = await params;
  const forbidden = await checkProjectPermission(user, projectId, 'risk:read');
  if (forbidden) return forbidden;

  // CSV エクスポートは admin / pm_tl のみ
  if (user.systemRole !== 'admin') {
    return NextResponse.json({ error: { code: 'FORBIDDEN' } }, { status: 403 });
  }

  const risks = await listRisks(projectId, user.id, user.systemRole);
  const csv = risksToCSV(risks);

  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="risks_${projectId}.csv"`,
    },
  });
}
