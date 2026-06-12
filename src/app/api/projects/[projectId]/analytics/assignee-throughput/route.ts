/**
 * GET /api/projects/[projectId]/analytics/assignee-throughput
 *
 * 役割:
 *   分析タブ「担当者別 週次消化工数」のデータソース。完了 ACT を実績完了日の週 ×
 *   担当者で集計し、週次の担当者別 実績工数 (人時) と工数効率を返す。
 *
 * 認可: checkProjectPermission('analytics:read') (PM/PL + admin のみ)。
 * 副作用: なし (読み取り専用)。
 *
 * 関連: src/services/analytics.service.ts (getAssigneeWeeklyEffort)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser, checkProjectPermission } from '@/lib/api-helpers';
import { getAssigneeWeeklyEffort } from '@/services/analytics.service';
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
  const data = await getAssigneeWeeklyEffort(projectId, user.tenantId, undefined, range);
  return NextResponse.json({ data });
}
