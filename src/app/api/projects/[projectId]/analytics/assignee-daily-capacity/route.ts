/**
 * GET /api/projects/[projectId]/analytics/assignee-daily-capacity
 *
 * 役割:
 *   分析タブ「担当者別 日次工数 (1 日 8h 上限チェック)」のデータソース。未完了 ACT の
 *   予定工数を日次に均等按分し、担当者×日付 (本日以降) の日次工数を閾値レベル付きで返す。
 *   特定日への負荷集中 (山積み) を発見し、負荷平準化・割り振り直しの材料にする。
 *
 * 認可: checkProjectPermission('analytics:read') (PM/PL + admin のみ)。
 * 副作用: なし (読み取り専用)。
 *
 * 関連: src/services/analytics.service.ts (getAssigneeDailyCapacity)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser, checkProjectPermission } from '@/lib/api-helpers';
import { getAssigneeDailyCapacity } from '@/services/analytics.service';
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
  const data = await getAssigneeDailyCapacity(projectId, user.tenantId, undefined, range);
  return NextResponse.json({ data });
}
