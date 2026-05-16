/**
 * PATCH /api/settings/theme (PR #72):
 *   ログインユーザ自身の画面テーマ設定を更新する。
 *   admin/一般ともに自分の設定のみ更新可 (他ユーザの設定を触る権限は無い)。
 *
 *   入力バリデーションで THEMES のキーに含まれる値のみ受理する。
 *   それ以外は 400 を返す (任意文字列で DB を汚染しないためのガード)。
 *
 * fix/theme-preference-cookie (2026-05-18):
 *   旧仕様は DB 更新 + クライアント側 useSession().update() で JWT 内 themePreference を
 *   書き換えていたが、NextAuth v5 0-beta.31 + @netlify/plugin-nextjs の組合せで
 *   Set-Cookie がブラウザに反映されない事象を確認 (JWT が古い値のまま固定化)。
 *
 *   layout.tsx は JWT を読んで <html data-theme> を決めるため、テーマ変更が即時反映されない。
 *
 *   対応として本ルートで非機密 cookie (tasukiba-theme) を直接 Set する。layout.tsx
 *   側でこの cookie を優先的に参照する (詳細は src/app/layout.tsx の該当箇所コメント参照)。
 *   JWT 経路も後方互換として残す。
 */

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { updateThemeSchema } from '@/lib/validators/theme';
import { THEME_COOKIE_NAME, THEME_COOKIE_MAX_AGE_SEC } from '@/config/themes';

export async function PATCH(req: NextRequest) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const body = await req.json().catch(() => null);
  const parsed = updateThemeSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', details: parsed.error.issues } },
      { status: 400 },
    );
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { themePreference: parsed.data.theme },
  });

  const response = NextResponse.json({ data: { theme: parsed.data.theme } });
  response.cookies.set(THEME_COOKIE_NAME, parsed.data.theme, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: THEME_COOKIE_MAX_AGE_SEC,
  });
  return response;
}
