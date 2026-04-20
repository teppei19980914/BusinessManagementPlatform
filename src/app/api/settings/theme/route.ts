/**
 * PATCH /api/settings/theme (PR #72):
 *   ログインユーザ自身の画面テーマ設定を更新する。
 *   admin/一般ともに自分の設定のみ更新可 (他ユーザの設定を触る権限は無い)。
 *
 *   入力バリデーションで THEMES のキーに含まれる値のみ受理する。
 *   それ以外は 400 を返す (任意文字列で DB を汚染しないためのガード)。
 */

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { updateThemeSchema } from '@/lib/validators/theme';

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

  return NextResponse.json({ data: { theme: parsed.data.theme } });
}
