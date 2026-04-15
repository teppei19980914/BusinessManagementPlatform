import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser, requireAdmin } from '@/lib/api-helpers';
import { updateMemberRole, removeMember } from '@/services/member.service';
import { recordAuditLog } from '@/services/audit.service';
import { z } from 'zod/v4';

const updateRoleSchema = z.object({
  projectRole: z.enum(['pm_tl', 'member', 'viewer']),
});

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string; memberId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const forbidden = requireAdmin(user);
  if (forbidden) return forbidden;

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
    const member = await updateMemberRole(memberId, parsed.data.projectRole, user.id);

    await recordAuditLog({
      userId: user.id,
      action: 'UPDATE',
      entityType: 'project_member',
      entityId: memberId,
      afterValue: { projectRole: parsed.data.projectRole },
    });

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
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const forbidden = requireAdmin(user);
  if (forbidden) return forbidden;

  const { memberId } = await params;

  try {
    await removeMember(memberId, user.id);

    await recordAuditLog({
      userId: user.id,
      action: 'DELETE',
      entityType: 'project_member',
      entityId: memberId,
    });

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
