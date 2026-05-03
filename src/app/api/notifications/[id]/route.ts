/**
 * PATCH /api/notifications/[id] - 通知の既読/未読を切り替え (PR feat/notifications-mvp)
 *
 * ボディ: { read: boolean }
 *
 * 認可: 通知の userId が認証済ユーザと一致する場合のみ。
 *   他人の通知を既読化できないようにする (CWE-639 IDOR 対策)。
 */

import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from 'next-intl/server';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { updateNotificationSchema } from '@/lib/validators/notification';
import { getNotification, setNotificationRead } from '@/services/notification.service';

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { id } = await params;
  const t = await getTranslations('message');
  const existing = await getNotification(id);
  if (!existing) {
    return NextResponse.json(
      { error: { code: 'NOT_FOUND', message: t('notFoundTarget') } },
      { status: 404 },
    );
  }
  if (existing.userId !== user.id) {
    return NextResponse.json(
      { error: { code: 'FORBIDDEN', message: t('forbidden') } },
      { status: 403 },
    );
  }

  const body = await req.json();
  const parsed = updateNotificationSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', details: parsed.error.issues } },
      { status: 400 },
    );
  }

  const updated = await setNotificationRead(id, parsed.data.read);
  return NextResponse.json({ data: updated });
}
