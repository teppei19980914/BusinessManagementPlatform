/**
 * POST /api/auth/logout-other-devices (feat/logout-other-devices, 2026-06-03):
 *   呼出ユーザの「現在の端末以外」のすべてのセッションを無効化する (= 他デバイス強制ログアウト)。
 *
 * 仕組み:
 *   1. DB の `user.tokenVersion` を increment する。これで**全端末** (現在の端末を含む) の
 *      既存 JWT が失効する (getAuthenticatedUser / requireAuthForLayout の tokenVersion 照合で 401)。
 *   2. **呼出端末のみ**、新しい tokenVersion で JWT を再署名して Set-Cookie する
 *      (`reissueAuthJwtOnResponse`)。これにより現在の端末はログインを維持する。
 *   3. 他端末は旧 tokenVersion の JWT のままなので、次回リクエストで自動的にログアウトされる。
 *
 * 認可: 認証済みユーザ本人のみ (自分のセッションのみ操作可能。他人のセッションには影響しない)。
 *
 * ★ middleware 除外必須:
 *   本 route は `src/middleware.ts` の matcher 除外リストに**必ず追加**する
 *   (`api/auth/mfa/verify` / `api/auth/explicit-signout` / `api/tenants/me/i18n` と同様)。
 *   さもないと NextAuth v5 の auth() middleware wrapper が `/api/auth/*` 配下で
 *   セッションリフレッシュ (旧 JWT 値で Set-Cookie 上書き) を行い、本 route の再署名 cookie が
 *   打ち消される (KDD §5.X+69 / §5.X+71 と同型の罠)。
 *
 * 関連:
 *   - JWT 再署名: src/lib/auth-jwt-helper.ts (Netlify で useSession().update() が壊れる対策)
 *   - tokenVersion 検証: src/lib/api-helpers.ts (getAuthenticatedUser) / src/lib/page-auth.ts
 *   - 既存 increment パターン: src/app/api/auth/explicit-signout/route.ts
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { prisma } from '@/lib/db';
import { reissueAuthJwtOnResponse } from '@/lib/auth-jwt-helper';
import { recordAuthEvent } from '@/services/auth-event.service';
import { recordError } from '@/services/error-log.service';

export async function POST(req: NextRequest) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  // 1. tokenVersion を increment → 全端末 (現在端末含む) の既存 JWT を失効。
  //    getAuthenticatedUser を通過した時点で user は DB に実在するため update で安全
  //    (P2025 の懸念なし)。新しい tokenVersion を select で取得して再署名に使う。
  let newTokenVersion: number;
  try {
    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { tokenVersion: { increment: 1 } },
      select: { tokenVersion: true },
    });
    newTokenVersion = updated.tokenVersion;
  } catch (e) {
    await recordError({
      severity: 'error',
      source: 'server',
      message: '[logout-other-devices] tokenVersion increment failed',
      stack: e instanceof Error ? e.stack : String(e),
      userId: user.id,
      tenantId: user.tenantId,
      context: { kind: 'logout_other_devices_increment_failed' },
    });
    return NextResponse.json(
      { error: { code: 'LOGOUT_OTHERS_FAILED', message: '他の端末のログアウトに失敗しました。再度お試しください。' } },
      { status: 500 },
    );
  }

  const response = NextResponse.json({ ok: true });

  // 2. 呼出端末のみ新 tokenVersion で JWT を再署名 → この端末はログインを維持。
  const reissue = await reissueAuthJwtOnResponse(req, response, {
    tokenVersion: newTokenVersion,
  });
  if (!reissue.ok) {
    // フェイルセーフ: 再署名に失敗した場合、現在端末の JWT も旧 tokenVersion のまま DB と
    //   不一致になり、次回リクエストでこの端末もログアウトされる (= 安全側に倒れる)。
    //   ユーザには「この端末も再ログインが必要」と明示する。
    return NextResponse.json(
      {
        error: {
          code: 'SESSION_REISSUE_FAILED',
          message: '他の端末のログアウトは完了しましたが、この端末のセッション更新に失敗しました。お手数ですが再度ログインしてください。',
        },
      },
      { status: 500 },
    );
  }

  // 3. 認証イベント記録 (監査用)。
  await recordAuthEvent({
    eventType: 'logout_other_devices',
    tenantId: user.tenantId,
    userId: user.id,
    email: user.email ?? undefined,
  });

  return response;
}
