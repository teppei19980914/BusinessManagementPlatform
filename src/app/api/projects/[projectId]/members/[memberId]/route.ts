import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { updateMemberRole, removeMember } from '@/services/member.service';
import { z } from 'zod/v4';

const updateRoleSchema = z.object({
  projectRole: z.enum(['pm_tl', 'member', 'viewer']),
});

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string; memberId: string }> },
) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: { code: 'UNAUTHORIZED' } }, { status: 401 });
  }
  if (session.user.systemRole !== 'admin') {
    return NextResponse.json({ error: { code: 'FORBIDDEN' } }, { status: 403 });
  }

  const { memberId } = await params;
  const body = await req.json();
  const parsed = updateRoleSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', details: parsed.error.issues } },
      { status: 400 },
    );
  }

  try {
    const member = await updateMemberRole(memberId, parsed.data.projectRole, session.user.id);
    return NextResponse.json({ data: member });
  } catch (e) {
    if (e instanceof Error && e.message === 'NOT_FOUND') {
      return NextResponse.json(
        { error: { code: 'NOT_FOUND', message: 'メンバーが見つかりません' } },
        { status: 404 },
      );
    }
    throw e;
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ projectId: string; memberId: string }> },
) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: { code: 'UNAUTHORIZED' } }, { status: 401 });
  }
  if (session.user.systemRole !== 'admin') {
    return NextResponse.json({ error: { code: 'FORBIDDEN' } }, { status: 403 });
  }

  const { memberId } = await params;

  try {
    await removeMember(memberId, session.user.id);
    return NextResponse.json({ data: { success: true } });
  } catch (e) {
    if (e instanceof Error && e.message === 'NOT_FOUND') {
      return NextResponse.json(
        { error: { code: 'NOT_FOUND', message: 'メンバーが見つかりません' } },
        { status: 404 },
      );
    }
    throw e;
  }
}
