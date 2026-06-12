/**
 * GET /api/projects/[projectId]/analytics/wbs-progress
 *
 * 役割:
 *   分析タブ「WBS 予実カーブ」のデータソース。ACT の予定完了日 / 実績完了日を
 *   累積した着手割合 (予定線・実績線) と本日サマリを返す。
 *
 * 認可: checkProjectPermission('analytics:read') (PM/PL + admin のみ)。
 * 副作用: なし (読み取り専用)。監査ログも残さない。
 *
 * 関連: src/services/analytics.service.ts (getWbsCompletionCurve)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser, checkProjectPermission } from '@/lib/api-helpers';
import { getWbsCompletionCurve } from '@/services/analytics.service';
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
  const data = await getWbsCompletionCurve(projectId, user.tenantId, undefined, range);
  return NextResponse.json({ data });
}
