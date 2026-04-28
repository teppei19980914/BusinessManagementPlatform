/**
 * POST /api/auth/mfa/disable - MFA 無効化
 *
 * 役割:
 *   ログイン中ユーザが自分の MFA を無効化する。
 *   admin (システム管理者) は MFA 必須のため、admin の場合は 403 を返す
 *   (disableMfa サービス側で判定)。
 *
 * 認可: getAuthenticatedUser (本人。admin はサービス側で再拒否)
 * 監査: disableMfa サービス内で auth_event_logs (eventType=mfa_disabled) を記録。
 *
 * 関連:
 *   - DESIGN.md §9.5 (MFA 設計 / 管理者必須)
 */

import { NextResponse } from 'next/server';
import { getTranslations } from 'next-intl/server';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { disableMfa } from '@/services/mfa.service';

export async function POST() {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  // 管理者は MFA を無効化できない
  if (user.systemRole === 'admin') {
    const t = await getTranslations('message');
    return NextResponse.json(
      { error: { code: 'FORBIDDEN', message: t('cannotDisableAdminMfa') } },
      { status: 403 },
    );
  }

  await disableMfa(user.id);
  return NextResponse.json({ data: { success: true } });
}
