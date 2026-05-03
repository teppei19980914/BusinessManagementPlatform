/**
 * POST /api/notifications/mark-all-read - 自分宛の未読通知を一括既読化 (PR feat/notifications-mvp)
 *
 * 認可: 認証済ユーザの自分の通知のみ対象。他人の通知に影響しない。
 *
 * 戻り値: { data: { count: <既読化件数> } }
 */

import { NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { markAllNotificationsRead } from '@/services/notification.service';

export async function POST() {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const result = await markAllNotificationsRead(user.id);
  return NextResponse.json({ data: result });
}
