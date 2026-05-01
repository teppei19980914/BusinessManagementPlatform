/**
 * GET /api/notifications - 自分宛の通知一覧 + 未読件数 (PR feat/notifications-mvp)
 *
 * クエリパラメータ:
 *   - includeRead=true : 既読も含めて返す (default: false = 未読のみ)
 *   - limit=N          : 取得件数上限 (default: 20、max: 100)
 *
 * レスポンス: { data: { items: NotificationDTO[]; unreadCount: number } }
 *
 * 認可: 認証済ユーザのみ。`userId = session.user.id` で他人の通知は読めない。
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { listNotificationsQuerySchema } from '@/lib/validators/notification';
import { listNotificationsForUser } from '@/services/notification.service';

export async function GET(req: NextRequest) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const url = new URL(req.url);
  const parsed = listNotificationsQuerySchema.safeParse({
    includeRead: url.searchParams.get('includeRead'),
    limit: url.searchParams.get('limit') ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', details: parsed.error.issues } },
      { status: 400 },
    );
  }

  const data = await listNotificationsForUser(user.id, {
    includeRead: parsed.data.includeRead,
    limit: parsed.data.limit,
  });
  return NextResponse.json({ data });
}
