/**
 * POST /api/cron/daily-notifications - 日次通知バッチ (PR feat/notifications-mvp)
 *
 * Vercel Cron で 1 日 1 回実行 (JST 7:00 = UTC 前日 22:00)。
 *
 * 処理内容:
 *   1. ACT (type='activity') の予定開始日/予定終了日リマインダ通知を生成
 *      - 開始: status='not_started' AND plannedStartDate=today (JST)
 *      - 終了: status≠'completed' AND plannedEndDate=today (JST)
 *   2. 既読 + readAt > 30 日 の通知を物理削除 (容量管理)
 *
 * 認可:
 *   Vercel Cron 経由のみ (Authorization: Bearer <CRON_SECRET>)。
 *   不正呼び出しは 401。
 *
 * 関連:
 *   - vercel.json `crons` セクション (実行スケジュール)
 *   - DEVELOPER_GUIDE §5.54 (本機能の KDD)
 *   - DESIGN.md §通知 (認可/削除/重複抑止の設計判断)
 */

import { NextRequest, NextResponse } from 'next/server';
import { generateDailyNotifications, cleanupReadNotifications } from '@/services/notification.service';

function isCronAuthorized(req: NextRequest): boolean {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return false;
  const header = req.headers.get('authorization');
  return header === `Bearer ${cronSecret}`;
}

export async function POST(req: NextRequest) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json(
      { error: { code: 'UNAUTHENTICATED' } },
      { status: 401 },
    );
  }

  const generated = await generateDailyNotifications();
  const cleaned = await cleanupReadNotifications();

  return NextResponse.json({
    data: {
      source: 'cron',
      generated,
      cleaned,
    },
  });
}

// Vercel Cron は HTTP GET / POST どちらも対応するが、本サービスは POST に統一。
// 念のため GET でアクセスがあれば 405 で明示的に弾く。
export async function GET() {
  return NextResponse.json(
    { error: { code: 'METHOD_NOT_ALLOWED' } },
    { status: 405 },
  );
}
