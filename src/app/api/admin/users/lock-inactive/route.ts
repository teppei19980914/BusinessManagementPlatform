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
// 2026-05-13 (security/auth-secret-hardening, B-6): 共通 cron 認可ヘルパに統一。
//   旧実装は本ファイル内のローカル定義で `===` 文字列比較していたが、
//   timingSafeEqual ベースの共通ヘルパへ移行。CRON_SECRET 最小長 32 文字も同時に強制。
//
// 2026-05-18 (PR feat/cron-execution-log): result type 化により失敗理由を診断可能に。
//   cron-job.org 側の Bearer prefix 漏れ / secret 不一致を error.code で識別できる。
//
// 認可の 2 経路:
//   1. 管理画面からの手動実行: セッション Cookie ありの admin ユーザ
//   2. cron-job.org 経由: Authorization: Bearer <CRON_SECRET> ヘッダ
//      (CRON_SECRET は Netlify 環境変数で設定)
//   どちらかを通過すれば実行可能。不正呼び出しは 401、Bearer の誤設定は専用 error code で 401。
import { checkCronAuthorization } from '@/lib/cron-auth';
import { withCronExecutionLogging } from '@/lib/cron-execution-log';

export async function POST(req: NextRequest) {
  // 経路 A: cron 認可ヘッダ (CRON_SECRET)
  //   全テナント横断ロック (システム運用、意図的に tenantScope 指定なし)。
  const authResult = checkCronAuthorization(req);
  if (authResult.ok) {
    return withCronExecutionLogging('lock-inactive-users', req, async () => {
      // cron 実行者は system (固定 UUID 相当)。監査ログは lockInactiveUsers 内で
      // `userId=<最初の admin userId>` で残す。該当 admin が居なければ cron スキップ。
      const firstAdmin = await prisma.user.findFirst({
        where: { systemRole: 'admin', isActive: true, deletedAt: null },
        select: { id: true },
      });
      if (!firstAdmin) {
        const t = await getTranslations('message');
        // withCronExecutionLogging が catch して failure ログを残せるよう throw する。
        throw new Error(t('adminUserNotFoundCron'));
      }
      // tenantScope 省略 = 全テナント横断 (cron 仕様)
      const result = await lockInactiveUsers(firstAdmin.id);
      return { data: { source: 'cron', ...result } };
    });
  }

  // 経路 A 失敗時: Bearer に関する誤設定を診断するため、reason が `server_secret_missing` /
  //   `no_bearer_header` 以外なら専用 error code で 401 を返す (= cron-job.org 設定誤りを
  //   レスポンス body から直接特定できる)。`no_bearer_header` は「Cookie 認証フォールバック対象」
  //   なので経路 B に進む。
  if (authResult.reason === 'invalid_bearer_format') {
    return NextResponse.json(
      { error: { code: 'CRON_BEARER_MALFORMED', message: 'Authorization header must start with "Bearer "' } },
      { status: 401 },
    );
  }
  if (authResult.reason === 'secret_mismatch') {
    return NextResponse.json(
      { error: { code: 'CRON_SECRET_MISMATCH', message: 'CRON_SECRET does not match' } },
      { status: 401 },
    );
  }
  if (authResult.reason === 'server_secret_missing') {
    return NextResponse.json(
      { error: { code: 'CRON_SECRET_MISCONFIGURED', message: 'CRON_SECRET env var is missing or too short on the server' } },
      { status: 500 },
    );
  }

  // 経路 B: 管理画面からの手動実行 (Authorization ヘッダ無し = no_bearer_header の場合のみ)
  //   2026-05-12 severity-1 修正: tenant admin (= systemRole='admin') は自テナント内のみ
  //   ロック可能。旧仕様は tenantScope 指定なしで `lockInactiveUsers(user.id)` を呼んでおり、
  //   tenant A の admin が tenant B のユーザを一斉ロックできるバグがあった。
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;
  const forbidden = requireAdmin(user);
  if (forbidden) return forbidden;

  // user.tenantId を tenantScope として渡す = 自テナント内のみロック
  const result = await lockInactiveUsers(user.id, user.tenantId);

  // 集約ログ (どのユーザをロックしたか個別は lockInactiveUsers 内で記録済)
  await recordAuditLog({
    tenantId: user.tenantId,
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
