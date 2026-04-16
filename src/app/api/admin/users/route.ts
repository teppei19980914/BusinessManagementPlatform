import { NextRequest, NextResponse } from 'next/server';
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
    const { user: newUser, recoveryCodes } = await createUser(parsed.data, user.id, { baseUrl });

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

    return NextResponse.json({ data: { user: newUser, recoveryCodes } }, { status: 201 });
  } catch (e) {
    if (e instanceof Error) {
      if (e.message === 'DUPLICATE_EMAIL') {
        return NextResponse.json(
          {
            error: {
              code: 'DUPLICATE_EMAIL',
              message: 'このメールアドレスは既に登録されています',
            },
          },
          { status: 409 },
        );
      }
      if (e.message === 'EMAIL_SEND_FAILED') {
        return NextResponse.json(
          {
            error: {
              code: 'EMAIL_SEND_FAILED',
              message:
                '検証メールの送信に失敗しました。メールアドレスを確認するか、しばらくしてから再度お試しください。',
            },
          },
          { status: 502 },
        );
      }
    }
    throw e;
  }
}
