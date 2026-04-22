/**
 * POST /api/admin/users/cleanup-inactive - 非アクティブユーザの自動削除 (PR #89)
 *
 * 役割:
 *   `lastLoginAt` (または未ログインの場合 `createdAt`) から
 *   `INACTIVE_USER_DELETION_DAYS` (=30) 日を経過した非 admin ユーザを
 *   一括で論理削除し、ProjectMember も物理削除する。
 *
 * 呼び出し経路:
 *   1. Vercel Cron (vercel.json の `crons` に登録、日次)
 *   2. 管理画面の「手動クリーンアップ実行」ボタン (admin 画面)
 *
 * 認可:
 *   - システム管理者 (対話型) または
 *   - Vercel Cron 認証ヘッダ (`x-vercel-cron: 1` or Authorization: Bearer <CRON_SECRET>)
 *   どちらかを通過すれば実行可能。本 MVP では Vercel Cron 側のヘッダ検証は割愛し、
 *   systemRole='admin' 要件のみ。cron 側は Vercel のサービスアカウント admin を
 *   使うか、将来的に CRON_SECRET 検証を追加する (SPECIFICATION.md §運用 参照)。
 *
 * 監査:
 *   削除された各ユーザに対し deleteUser 内で roleChangeLog が 1 行ずつ記録される。
 *   ここでは集約 audit_log も 1 行残す (cleanup 実行記録)。
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser, requireAdmin } from '@/lib/api-helpers';
import { cleanupInactiveUsers } from '@/services/user.service';
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
    // cron 実行者は system (固定 UUID 相当)。監査ログは deleteUser 内 roleChangeLog に
    // `changedBy=<最初の admin userId>` で残す想定。ここでは admin ユーザを 1 件拾って
    // 代表として使う (監査整合性のため; 該当 admin が居なければ cron スキップ)。
    const firstAdmin = await prisma.user.findFirst({
      where: { systemRole: 'admin', isActive: true, deletedAt: null },
      select: { id: true },
    });
    if (!firstAdmin) {
      return NextResponse.json(
        { error: { code: 'NO_ADMIN', message: 'admin ユーザが存在しないため cron 実行不可' } },
        { status: 500 },
      );
    }
    const result = await cleanupInactiveUsers(firstAdmin.id);
    return NextResponse.json({ data: { source: 'cron', ...result } });
  }

  // 経路 B: 管理画面からの手動実行
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;
  const forbidden = requireAdmin(user);
  if (forbidden) return forbidden;

  const result = await cleanupInactiveUsers(user.id);

  // 集約ログ (どのユーザを削除したか個別は deleteUser 内で記録済)
  await recordAuditLog({
    userId: user.id,
    action: 'DELETE',
    entityType: 'user',
    entityId: user.id, // 実行主体の userId を entityId に (UUID カラム制約のため実値)
    afterValue: {
      action: 'cleanup_inactive_users',
      deletedUserCount: result.deletedUserIds.length,
      removedMembershipsTotal: result.removedMembershipsTotal,
    },
  });

  return NextResponse.json({ data: { source: 'manual', ...result } });
}
