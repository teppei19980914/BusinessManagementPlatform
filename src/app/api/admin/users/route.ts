import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { createUserSchema } from '@/lib/validators/auth';
import { listUsers, createUser } from '@/services/user.service';

export async function GET() {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: { code: 'UNAUTHORIZED' } }, { status: 401 });
  }
  if (session.user.systemRole !== 'admin') {
    return NextResponse.json({ error: { code: 'FORBIDDEN' } }, { status: 403 });
  }

  const users = await listUsers();
  return NextResponse.json({ data: users });
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: { code: 'UNAUTHORIZED' } }, { status: 401 });
  }
  if (session.user.systemRole !== 'admin') {
    return NextResponse.json({ error: { code: 'FORBIDDEN' } }, { status: 403 });
  }

  const body = await req.json();
  const parsed = createUserSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', details: parsed.error.issues } },
      { status: 400 },
    );
  }

  try {
    const { user, recoveryCodes } = await createUser(parsed.data, session.user.id);
    return NextResponse.json({ data: { user, recoveryCodes } }, { status: 201 });
  } catch (e) {
    if (e instanceof Error && e.message === 'DUPLICATE_EMAIL') {
      return NextResponse.json(
        { error: { code: 'VALIDATION_ERROR', message: 'このメールアドレスは既に登録されています' } },
        { status: 409 },
      );
    }
    throw e;
  }
}
