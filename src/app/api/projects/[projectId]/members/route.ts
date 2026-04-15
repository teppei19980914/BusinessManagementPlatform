import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { listMembers, addMember } from '@/services/member.service';
import { z } from 'zod/v4';

const addMemberSchema = z.object({
  userId: z.string().uuid(),
  projectRole: z.enum(['pm_tl', 'member', 'viewer']),
});

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: { code: 'UNAUTHORIZED' } }, { status: 401 });
  }
  if (session.user.systemRole !== 'admin') {
    return NextResponse.json({ error: { code: 'FORBIDDEN' } }, { status: 403 });
  }

  const { projectId } = await params;
  const members = await listMembers(projectId);
  return NextResponse.json({ data: members });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: { code: 'UNAUTHORIZED' } }, { status: 401 });
  }
  if (session.user.systemRole !== 'admin') {
    return NextResponse.json({ error: { code: 'FORBIDDEN' } }, { status: 403 });
  }

  const { projectId } = await params;
  const body = await req.json();
  const parsed = addMemberSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', details: parsed.error.issues } },
      { status: 400 },
    );
  }

  try {
    const member = await addMember(
      projectId,
      parsed.data.userId,
      parsed.data.projectRole,
      session.user.id,
    );
    return NextResponse.json({ data: member }, { status: 201 });
  } catch (e) {
    if (e instanceof Error) {
      if (e.message === 'USER_NOT_FOUND') {
        return NextResponse.json(
          { error: { code: 'NOT_FOUND', message: 'ユーザが見つかりません' } },
          { status: 404 },
        );
      }
      if (e.message === 'ALREADY_MEMBER') {
        return NextResponse.json(
          { error: { code: 'VALIDATION_ERROR', message: '既にメンバーに追加されています' } },
          { status: 409 },
        );
      }
    }
    throw e;
  }
}
