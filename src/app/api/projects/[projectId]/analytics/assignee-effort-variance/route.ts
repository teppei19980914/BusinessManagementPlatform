/**
 * GET /api/projects/[projectId]/analytics/assignee-effort-variance
 *
 * 役割:
 *   分析タブ「担当者別 予定 vs 実績 工数 (工数の予実差)」のデータソース。
 *   完了 + 実工数入力済の ACT を担当者別に予定工数 / 実績工数で SUM し、
 *   見積もり・割り振りの参考になる予実差を返す。
 *
 * 認可: checkProjectPermission('analytics:read') (PM/PL + admin のみ)。
 * 副作用: なし (読み取り専用)。
 *
 * 関連: src/services/analytics.service.ts (getAssigneeEffortVariance)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser, checkProjectPermission } from '@/lib/api-helpers';
import { getAssigneeEffortVariance } from '@/services/analytics.service';
import { parseAnalyticsRange } from '@/lib/analytics-range';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { projectId } = await params;
  const forbidden = await checkProjectPermission(user, projectId, 'analytics:read');
  if (forbidden) return forbidden;

  const range = parseAnalyticsRange(new URL(req.url).searchParams);
  const data = await getAssigneeEffortVariance(projectId, user.tenantId, range);
  return NextResponse.json({ data });
}
