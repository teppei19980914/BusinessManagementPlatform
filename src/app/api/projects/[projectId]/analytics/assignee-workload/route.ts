/**
 * GET /api/projects/[projectId]/analytics/assignee-workload
 *
 * 役割:
 *   分析タブ「担当者別 作業負担」のデータソース。未完了 ACT の予定工数を担当者×状態で
 *   集計し、各担当者の個人ペース比 (実績÷予定) とあわせて返す。負荷分散・割り振りの材料。
 *
 * 認可: checkProjectPermission('analytics:read') (PM/PL + admin のみ)。
 * 副作用: なし (読み取り専用)。
 *
 * 関連: src/services/analytics.service.ts (getAssigneeWorkload)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser, checkProjectPermission } from '@/lib/api-helpers';
import { getAssigneeWorkload } from '@/services/analytics.service';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { projectId } = await params;
  const forbidden = await checkProjectPermission(user, projectId, 'analytics:read');
  if (forbidden) return forbidden;

  const data = await getAssigneeWorkload(projectId, user.tenantId);
  return NextResponse.json({ data });
}
