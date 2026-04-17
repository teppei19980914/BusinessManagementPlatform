import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser, checkProjectPermission, requireAdmin } from '@/lib/api-helpers';
import { listMembers, addMember } from '@/services/member.service';
import { recordAuditLog } from '@/services/audit.service';
import { z } from 'zod/v4';

const addMemberSchema = z.object({
  userId: z.string().uuid(),
  projectRole: z.enum(['pm_tl', 'member', 'viewer']),
});

// GET: 担当者ドロップダウンや WBS/リスクタブでメンバー一覧を参照するため、
// プロジェクトメンバー全員に許可（従来 SSR の page.tsx で listMembers を全員に配布していたのと同等）
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { projectId } = await params;
  const forbidden = await checkProjectPermission(user, projectId, 'project:read');
  if (forbidden) return forbidden;

  const members = await listMembers(projectId);
  return NextResponse.json({ data: members });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const forbidden = requireAdmin(user);
  if (forbidden) return forbidden;

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
      user.id,
    );

    await recordAuditLog({
      userId: user.id,
      action: 'CREATE',
      entityType: 'project_member',
      entityId: member.id,
      afterValue: { projectId, userId: parsed.data.userId, projectRole: parsed.data.projectRole },
    });

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
