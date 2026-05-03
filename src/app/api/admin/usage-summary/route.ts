/**
 * GET /api/admin/usage-summary - 全テナント使用量サマリ (admin 用、PR #7 / T-03)
 *
 * 役割:
 *   admin が全テナントの API 利用状況を一覧で確認できる JSON エンドポイント。
 *   将来 super_admin ダッシュボード (PR-X2) の UI から呼ばれる想定。
 *
 * 認可:
 *   - 現状: `systemRole='admin'` のみアクセス可
 *   - 将来 (PR-X2): `systemRole='super_admin'` に限定予定
 *
 * クエリパラメータ:
 *   - `date`: 集計対象日 (YYYY-MM-DD)。省略時は本日 UTC
 *
 * レスポンス:
 *   AdminUsageSummary (src/services/usage-monitoring.service.ts 参照)
 *
 * 関連:
 *   - 計画: docs/roadmap/SUGGESTION_ENGINE_PLAN.md PR #7
 *   - 後続: PR-X2 (super_admin ダッシュボード UI)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { getAdminUsageSummary } from '@/services/usage-monitoring.service';

export async function GET(req: NextRequest) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  // 現状は admin に限定。super_admin 導入後は isSuperAdmin() に切替予定。
  if (user.systemRole !== 'admin') {
    return NextResponse.json(
      { error: { code: 'FORBIDDEN' } },
      { status: 403 },
    );
  }

  // クエリパラメータの date を受け取る (任意)
  const dateParam = req.nextUrl.searchParams.get('date');
  let targetDate: Date | undefined;
  if (dateParam) {
    const parsed = new Date(dateParam);
    if (isNaN(parsed.getTime())) {
      return NextResponse.json(
        { error: { code: 'VALIDATION_ERROR', message: 'date must be YYYY-MM-DD' } },
        { status: 400 },
      );
    }
    targetDate = parsed;
  }

  const summary = await getAdminUsageSummary(targetDate);
  return NextResponse.json({ data: summary });
}
