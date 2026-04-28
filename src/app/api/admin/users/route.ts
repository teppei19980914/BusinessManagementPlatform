/**
 * GET  /api/admin/users - 全ユーザ一覧取得
 * POST /api/admin/users - ユーザ新規発行 (検証メール送信)
 *
 * 役割:
 *   システム管理者がアカウントを発行するエンドポイント。POST 時はパスワードを
 *   設定せず検証メールを送り、受信者が /setup-password で初回パスワード設定する。
 *
 * 認可: requireAdmin (システム管理者のみ)
 *
 * 監査:
 *   POST 成功時に audit_logs (action=CREATE, entityType=user) と
 *   auth_event_logs (eventType=account_created) の双方に記録。
 *
 * エラー:
 *   - 重複メール → 409 DUPLICATE_EMAIL
 *   - メール送信失敗 → 502 EMAIL_SEND_FAILED (ユーザレコードは残る)
 *
 * 関連:
 *   - DESIGN.md §9 (セキュリティ設計 / 新規発行フロー)
 *   - SPECIFICATION.md (ユーザ管理画面)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from 'next-intl/server';
import { getAuthenticatedUser, requireAdmin } from '@/lib/api-helpers';
import { createUserSchema } from '@/lib/validators/auth';
import { listUsers, createUser } from '@/services/user.service';
import { recordAuditLog, sanitizeForAudit } from '@/services/audit.service';
import { recordAuthEvent } from '@/services/auth-event.service';

export async function GET() {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const forbidden = requireAdmin(user);
  if (forbidden) return forbidden;

  const users = await listUsers();
  return NextResponse.json({ data: users });
}

export async function POST(req: NextRequest) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const forbidden = requireAdmin(user);
  if (forbidden) return forbidden;

  const body = await req.json();
  const parsed = createUserSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', details: parsed.error.issues } },
      { status: 400 },
    );
  }

  try {
    const baseUrl = process.env.NEXTAUTH_URL || req.nextUrl.origin;
    const { user: newUser } = await createUser(parsed.data, user.id, { baseUrl });

    await recordAuditLog({
      userId: user.id,
      action: 'CREATE',
      entityType: 'user',
      entityId: newUser.id,
      afterValue: sanitizeForAudit(newUser as unknown as Record<string, unknown>),
    });

    await recordAuthEvent({
      eventType: 'account_created',
      userId: newUser.id,
      email: newUser.email,
      detail: { createdBy: user.id },
    });

    return NextResponse.json({ data: { user: newUser } }, { status: 201 });
  } catch (e) {
    if (e instanceof Error) {
      if (e.message === 'DUPLICATE_EMAIL') {
        const tAdmin = await getTranslations('admin.users');
        return NextResponse.json(
          {
            error: {
              code: 'DUPLICATE_EMAIL',
              message: tAdmin('duplicateEmail'),
            },
          },
          { status: 409 },
        );
      }
      if (e.message === 'EMAIL_SEND_FAILED') {
        const tAdmin = await getTranslations('admin.users');
        return NextResponse.json(
          {
            error: {
              code: 'EMAIL_SEND_FAILED',
              message: tAdmin('invitationSendFailed'),
            },
          },
          { status: 502 },
        );
      }
    }
    throw e;
  }
}
