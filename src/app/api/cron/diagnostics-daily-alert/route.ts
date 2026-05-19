/**
 * POST /api/cron/diagnostics-daily-alert (PR-V8.4 / 2026-05-19)
 *
 * 役割:
 *   診断ダッシュボード `/admin/super/diagnostics` の検知件数を日次集約し、
 *   1 件以上の異常があれば super_admin にメール通知する。
 *
 *   ダッシュボード未閲覧期間の無音を防ぐ目的。重要事象 (API drift / Stripe queue 滞留 /
 *   請求書計算ミス等) を super_admin の inbox に push し、確実に気付けるようにする。
 *
 * 推奨スケジュール: 毎日 1 回 (= 11:30 JST、cron-failure-alert より 30 分後)
 *
 * 認可: Authorization: Bearer <CRON_SECRET>
 *
 * 関連:
 *   - サービス: src/services/admin-alert.service.ts detectAndAlertDiagnosticsAnomalies
 *   - ダッシュボード: src/app/(dashboard)/admin/super/diagnostics/page.tsx
 */

import { NextRequest, NextResponse } from 'next/server';
import { isCronAuthorized } from '@/lib/cron-auth';
import { withCronExecutionLogging } from '@/lib/cron-execution-log';
import { detectAndAlertDiagnosticsAnomalies } from '@/services/admin-alert.service';

export async function POST(req: NextRequest) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json(
      { error: { code: 'UNAUTHENTICATED' } },
      { status: 401 },
    );
  }

  return withCronExecutionLogging('diagnostics-daily-alert', req, async () => {
    const result = await detectAndAlertDiagnosticsAnomalies();
    return { data: { source: 'cron', ...result } };
  });
}

export async function GET() {
  return NextResponse.json(
    { error: { code: 'METHOD_NOT_ALLOWED' } },
    { status: 405 },
  );
}
