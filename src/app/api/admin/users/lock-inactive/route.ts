/**
 * POST /api/admin/users/lock-inactive - 非アクティブユーザの自動ロック (旧名: cleanup-inactive)
 *
 * feat/account-lock 改修:
 *   旧仕様 (PR #89) は閾値経過の非 admin を **論理削除** していたが、
 *   ナレッジ参照のためアカウントを残し **isActive=false (ロック)** にする方針へ変更。
 *   復帰は admin が `/admin/users` で isActive をトグル。
 *
 * 役割:
 *   `lastLoginAt` (または未ログインの場合 `createdAt`) から
 *   `INACTIVE_USER_LOCK_DAYS` (=30) 日を経過した非 admin ユーザを
 *   一括で **isActive=false** に更新する。ProjectMember は維持される
 *   (旧仕様のカスケード物理削除は行わない)。
 *
 * 呼び出し経路:
 *   1. Vercel Cron (vercel.json の `crons` に登録、日次)
 *   2. 管理画面の「手動ロック実行」ボタン (admin 画面)
 *
 * 認可:
 *   - システム管理者 (対話型) または
 *   - Vercel Cron 認証ヘッダ (`Authorization: Bearer <CRON_SECRET>`)
 *
 * 監査:
 *   ロックされた各ユーザに対し lockInactiveUsers 内で audit_log を 1 件記録
 *   (action='UPDATE', entityType='user', after.reason='30 日無アクティブ自動ロック')。
 *   ここでは集約 audit_log も 1 件残す (実行記録)。
 */

import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from 'next-intl/server';
import { getAuthenticatedUser, requireAdmin } from '@/lib/api-helpers';
import { lockInactiveUsers } from '@/services/user.service';
import { recordAuditLog } from '@/services/audit.service';
import { prisma } from '@/lib/db';

/**
 * 認可の 2 経路:
 *   1. 管理画面からの手動実行: セッション Cookie ありの admin ユーザ
 *   2. Vercel Cron: Authorization: Bearer <CRON_SECRET> ヘッダ
 *      (CRON_SECRET は Vercel Project 環境変数で設定)
 *   どちらかを通過すれば実行可能。不正呼び出し (匿名 POST) は 401 で拒否。
 */
function isCronAuthorized(req: NextRequest): boolean {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return false;
  const header = req.headers.get('authorization');
  return header === `Bearer ${cronSecret}`;
}

export async function POST(req: NextRequest) {
  // 経路 A: Vercel Cron (CRON_SECRET ヘッダ)
  if (isCronAuthorized(req)) {
    // cron 実行者は system (固定 UUID 相当)。監査ログは lockInactiveUsers 内で
    // `userId=<最初の admin userId>` で残す。該当 admin が居なければ cron スキップ。
    const firstAdmin = await prisma.user.findFirst({
      where: { systemRole: 'admin', isActive: true, deletedAt: null },
      select: { id: true },
    });
    if (!firstAdmin) {
      const t = await getTranslations('message');
      return NextResponse.json(
        { error: { code: 'NO_ADMIN', message: t('adminUserNotFoundCron') } },
        { status: 500 },
      );
    }
    const result = await lockInactiveUsers(firstAdmin.id);
    return NextResponse.json({ data: { source: 'cron', ...result } });
  }

  // 経路 B: 管理画面からの手動実行
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;
  const forbidden = requireAdmin(user);
  if (forbidden) return forbidden;

  const result = await lockInactiveUsers(user.id);

  // 集約ログ (どのユーザをロックしたか個別は lockInactiveUsers 内で記録済)
  await recordAuditLog({
    userId: user.id,
    action: 'UPDATE',
    entityType: 'user',
    entityId: user.id, // 実行主体の userId を entityId に (UUID カラム制約のため実値)
    afterValue: {
      action: 'lock_inactive_users',
      lockedUserCount: result.lockedUserIds.length,
    },
  });

  return NextResponse.json({ data: { source: 'manual', ...result } });
}
