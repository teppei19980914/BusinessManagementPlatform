/**
 * POST /api/auth/mfa/disable - MFA 無効化
 *
 * 役割:
 *   ログイン中ユーザが自分の MFA を無効化する。
 *   2026-05-09 (#11): MFA 強制対象を super_admin のみに限定。super_admin は引き続き
 *     無効化禁止 (横断アクセス保護)。テナント管理者 (admin) と一般ユーザは無効化可能。
 *
 * 認可: getAuthenticatedUser (本人。super_admin はサービス側で再拒否)
 * 監査: disableMfa サービス内で auth_event_logs (eventType=mfa_disabled) を記録。
 */

import { NextResponse } from 'next/server';
import { getTranslations } from 'next-intl/server';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { disableMfa } from '@/services/mfa.service';

export async function POST() {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  // 2026-05-09 (#11): プラットフォーム運営者 (super_admin) のみ MFA 必須を維持。
  if (user.systemRole === 'super_admin') {
    const t = await getTranslations('message');
    return NextResponse.json(
      { error: { code: 'FORBIDDEN', message: t('cannotDisableAdminMfa') } },
      { status: 403 },
    );
  }

  await disableMfa(user.id);
  return NextResponse.json({ data: { success: true } });
}
