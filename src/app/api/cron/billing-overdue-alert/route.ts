/**
 * POST /api/cron/billing-overdue-alert (PR-V7a / 2026-05-19)
 *
 * 役割:
 *   銀行振込テナントで支払期日 (+ 5 日猶予) 超過の請求書を検知し、
 *   super_admin にメール alert + overdueAlertSentAt 更新 (24h dedup)。
 *
 * 推奨スケジュール: 毎日 1 回 (= 08:00 UTC = JST 17:00)
 *
 * 認可: Authorization: Bearer <CRON_SECRET>
 *
 * 関連:
 *   - サービス: src/services/admin-alert.service.ts detectAndAlertOverdueInvoices
 *   - 監査 B-G-2 (S-2 優先度): 入金期日超過の自動検知
 */

import { NextRequest, NextResponse } from 'next/server';
import { isCronAuthorized } from '@/lib/cron-auth';
import { withCronExecutionLogging } from '@/lib/cron-execution-log';
import { detectAndAlertOverdueInvoices } from '@/services/admin-alert.service';

export async function POST(req: NextRequest) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json(
      { error: { code: 'UNAUTHENTICATED' } },
      { status: 401 },
    );
  }

  return withCronExecutionLogging('billing-overdue-alert', req, async () => {
    const result = await detectAndAlertOverdueInvoices();
    return { data: { source: 'cron', ...result } };
  });
}

export async function GET() {
  return NextResponse.json(
    { error: { code: 'METHOD_NOT_ALLOWED' } },
    { status: 405 },
  );
}
