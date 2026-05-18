/**
 * POST /api/admin/super/stripe-dlq/usage/[id]/retry (PR-V7 #6 / 2026-05-19)
 *
 * super_admin が Stripe Usage Record queue 行を手動再投入する。
 * DLQ (= sentAt=null AND nextSendAt=null) または送信失敗中の行に対し
 * retryCount=0, nextSendAt=now を設定 → 次回 stripe-usage-flush cron で送信される。
 *
 * idempotency_key は元のままなので Stripe 側で重複排除される (= 二重課金リスクなし)。
 *
 * 認可: super_admin role 必須。
 *
 * 関連:
 *   - サービス: src/services/stripe-dlq.service.ts retryUsageQueueRow
 *   - UI: src/app/(dashboard)/admin/super/stripe-dlq/page.tsx
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { isSuperAdmin } from '@/lib/permissions/role';
import { retryUsageQueueRow } from '@/services/stripe-dlq.service';

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;
  if (!isSuperAdmin(user)) {
    return NextResponse.json({ error: { code: 'FORBIDDEN' } }, { status: 403 });
  }

  const { id } = await params;
  const result = await retryUsageQueueRow(id, user.id);
  if (!result.ok) {
    if (result.error === 'ROW_NOT_FOUND') {
      return NextResponse.json(
        { error: { code: 'ROW_NOT_FOUND', message: '対象 queue 行が見つかりません' } },
        { status: 404 },
      );
    }
    if (result.error === 'ALREADY_SENT') {
      return NextResponse.json(
        { error: { code: 'ALREADY_SENT', message: '既に送信済の行です' } },
        { status: 409 },
      );
    }
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: result.error } },
      { status: 500 },
    );
  }
  return NextResponse.json({ data: { ok: true, id: result.id } });
}
