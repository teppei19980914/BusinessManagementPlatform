/**
 * POST /api/cron/cron-failure-alert (PR-V7a / 2026-05-19)
 *
 * 役割:
 *   直近 24h で status='failure' な cron 実行を検知し、cron 別に集約して super_admin にメール通知。
 *   特に stripe-reconcile / billing-monthly-aggregation の失敗は請求業務直結のため最優先で気付かせる。
 *
 * 推奨スケジュール: 毎日 1 回 (= 09:00 UTC = JST 18:00、他の cron 群が完走した後)
 *
 * 認可: Authorization: Bearer <CRON_SECRET>
 *
 * 関連:
 *   - サービス: src/services/admin-alert.service.ts detectAndAlertCronFailures
 *   - 監査 B-G-6 (A 優先度): cron 失敗時の自動 alert
 */

import { NextRequest, NextResponse } from 'next/server';
import { isCronAuthorized } from '@/lib/cron-auth';
import { withCronExecutionLogging } from '@/lib/cron-execution-log';
import { detectAndAlertCronFailures } from '@/services/admin-alert.service';

export async function POST(req: NextRequest) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json(
      { error: { code: 'UNAUTHENTICATED' } },
      { status: 401 },
    );
  }

  return withCronExecutionLogging('cron-failure-alert', req, async () => {
    const result = await detectAndAlertCronFailures();
    return { data: { source: 'cron', ...result } };
  });
}

export async function GET() {
  return NextResponse.json(
    { error: { code: 'METHOD_NOT_ALLOWED' } },
    { status: 405 },
  );
}
