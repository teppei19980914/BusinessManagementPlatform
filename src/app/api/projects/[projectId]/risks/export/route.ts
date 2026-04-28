/**
 * GET /api/projects/[projectId]/risks/export — リスク/課題 CSV エクスポート
 *
 * 役割:
 *   2 モードあり:
 *     - mode='summary' (既定、後方互換): 8 列 PMO 報告書用サマリ format
 *     - mode='sync' (T-22 Phase 22a): 16 列 sync-import 往復編集用 full-fidelity format
 *
 * 認可:
 *   summary: checkProjectPermission('risk:read') + admin only (PMO 報告は管理者用途)
 *   sync   : checkProjectPermission('risk:update') (上書き編集の準備として update 権限)
 *
 * 関連:
 *   - DEVELOPER_GUIDE §11 T-22 Phase 22a
 *   - src/services/risk-sync-import.service.ts (sync 形式の出力実装)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser, checkProjectPermission } from '@/lib/api-helpers';
import { listRisks, risksToCSV } from '@/services/risk.service';
import { exportRisksSync } from '@/services/risk-sync-import.service';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { projectId } = await params;
  const url = new URL(req.url);
  const mode = url.searchParams.get('mode') === 'sync' ? 'sync' : 'summary';

  if (mode === 'sync') {
    // sync mode は upsert 用のため update 権限を要求 (実 import は別 endpoint で再確認)
    const forbidden = await checkProjectPermission(user, projectId, 'risk:update');
    if (forbidden) return forbidden;

    const csv = await exportRisksSync(projectId, user.id, user.systemRole);
    return new NextResponse(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="risks_sync_${projectId}.csv"`,
      },
    });
  }

  // summary mode (既定、後方互換)
  const forbidden = await checkProjectPermission(user, projectId, 'risk:read');
  if (forbidden) return forbidden;

  // CSV エクスポート (summary) は admin のみ
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
