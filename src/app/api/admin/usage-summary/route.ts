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
import { isAdminOrAbove } from '@/lib/permissions';

export async function GET(req: NextRequest) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  // feat/crud-permission-redesign (2026-05-20): 旧 `=== 'admin'` 厳密比較を isAdminOrAbove に統一。
  //   旧コメント「super_admin 導入後は isSuperAdmin() に切替予定」 → 他の admin API (audit-logs,
  //   role-change-logs 等) と同じく super_admin も通過させる方向で確定 (UI/API 認可一致)。
  if (!isAdminOrAbove(user)) {
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

  // 2026-05-10 feedback Phase 2-9: 越境取得を遮断するため自テナントの分のみ返す。
  //   全テナント横断は将来 super_admin (PR-X2) 導入後にロール分岐する。
  //   現状の admin はテナント内権限なので、自テナント分のみ可視。
  const myTenant = summary.tenants.find((t) => t.tenantId === user.tenantId);
  const filteredAnomalies = summary.anomalies.filter((a) => a.tenantId === user.tenantId);
  const filteredAlerts = summary.budgetAlerts.filter((b) => b.tenantId === user.tenantId);
  const filtered = {
    date: summary.date,
    tenants: myTenant ? [myTenant] : [],
    total: myTenant
      ? {
          tenantCount: 1,
          callCount: myTenant.callCount,
          costJpy: myTenant.costJpy,
          embeddingTokens: myTenant.embeddingTokens,
          llmInputTokens: myTenant.llmInputTokens,
          llmOutputTokens: myTenant.llmOutputTokens,
        }
      : { tenantCount: 0, callCount: 0, costJpy: 0, embeddingTokens: 0, llmInputTokens: 0, llmOutputTokens: 0 },
    anomalies: filteredAnomalies,
    budgetAlerts: filteredAlerts,
  };
  return NextResponse.json({ data: filtered });
}
