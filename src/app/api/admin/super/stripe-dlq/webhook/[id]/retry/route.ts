/**
 * POST /api/admin/super/stripe-dlq/webhook/[id]/retry (PR-V7 #6 / 2026-05-19)
 *
 * super_admin が Stripe Webhook event を手動再投入する。
 * DLQ (= retryCount >= 4) または処理失敗中の event に対して retryCount=0, nextRetryAt=now を設定。
 *
 * 認可: super_admin role 必須。
 *
 * 注: Stripe 側からは 3 日以上前の event は自動再送されないので、本 API でメタデータをリセットしても
 *   Stripe の手動 replay が別途必要なケースがある。UI 側で「Stripe Dashboard で manual replay 必要」
 *   旨を案内する。
 *
 * 関連:
 *   - サービス: src/services/stripe-dlq.service.ts retryWebhookEvent
 *   - UI: src/app/(dashboard)/admin/super/stripe-dlq/page.tsx
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { isSuperAdmin } from '@/lib/permissions/role';
import { retryWebhookEvent } from '@/services/stripe-dlq.service';

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
  const result = await retryWebhookEvent(id, user.id);
  if (!result.ok) {
    if (result.error === 'EVENT_NOT_FOUND') {
      return NextResponse.json(
        { error: { code: 'EVENT_NOT_FOUND', message: '対象 Webhook event が見つかりません' } },
        { status: 404 },
      );
    }
    if (result.error === 'ALREADY_PROCESSED') {
      return NextResponse.json(
        { error: { code: 'ALREADY_PROCESSED', message: '既に処理済の event です' } },
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
