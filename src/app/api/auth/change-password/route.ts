/**
 * POST /api/auth/change-password - ログイン中ユーザによる自分のパスワード変更
 *
 * 役割:
 *   ログイン中のユーザが自分のパスワードを変更する。現パスワードによる本人確認 →
 *   新パスワードのポリシー検証 → 履歴チェック (直近 N 件と同一不可) → 更新を行う。
 *
 * 認可: getAuthenticatedUser (ログイン中ユーザ本人)
 * 監査: changePassword サービス内で auth_event_logs に password_changed を記録。
 *
 * 関連:
 *   - DESIGN.md §9.4 (パスワードポリシー / 履歴チェック)
 *   - src/config/security.ts (BCRYPT_COST / PASSWORD_HISTORY_COUNT)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { changePasswordSchema } from '@/lib/validators/password';
import { changePassword } from '@/services/password.service';

export async function POST(req: NextRequest) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const body = await req.json();
  const parsed = changePasswordSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', details: parsed.error.issues } },
      { status: 400 },
    );
  }

  const result = await changePassword(user.id, parsed.data.currentPassword, parsed.data.newPassword);

  if (!result.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', message: result.error } },
      { status: 400 },
    );
  }

  return NextResponse.json({ data: { success: true } });
}
