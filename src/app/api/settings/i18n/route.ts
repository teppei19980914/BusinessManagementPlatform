/**
 * PATCH /api/settings/i18n (PR #119):
 *   ログインユーザ自身の i18n 設定 (timezone / locale) を更新する。
 *   admin/一般ともに自分の設定のみ更新可 (他ユーザの設定を触る権限は無い)。
 *
 *   入力バリデーションで IANA TZ / SUPPORTED_LOCALES のみ受理 (それ以外は 400)。
 *   null を受理して「システム既定に戻す」を可能にする。
 *
 *   クライアントは返却後に useSession().update({ timezone, locale }) で JWT を
 *   上書きし、次レンダリングから新 TZ/locale が反映される。
 */

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { updateI18nSchema } from '@/lib/validators/i18n';

export async function PATCH(req: NextRequest) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const body = await req.json().catch(() => null);
  const parsed = updateI18nSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', details: parsed.error.issues } },
      { status: 400 },
    );
  }

  // 部分更新 (指定されたキーのみ更新)。null は明示的に NULL に戻す意味。
  const data: { timezone?: string | null; locale?: string | null } = {};
  if ('timezone' in parsed.data) data.timezone = parsed.data.timezone ?? null;
  if ('locale' in parsed.data) data.locale = parsed.data.locale ?? null;

  if (Object.keys(data).length === 0) {
    // no-op: 空オブジェクトが来ても現状値を返す (UI 側で state 同期するため)
    const current = await prisma.user.findUnique({
      where: { id: user.id },
      select: { timezone: true, locale: true },
    });
    return NextResponse.json({
      data: { timezone: current?.timezone ?? null, locale: current?.locale ?? null },
    });
  }

  const updated = await prisma.user.update({
    where: { id: user.id },
    data,
    select: { timezone: true, locale: true },
  });

  return NextResponse.json({
    data: { timezone: updated.timezone, locale: updated.locale },
  });
}
