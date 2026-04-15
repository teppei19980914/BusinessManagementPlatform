import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser, checkProjectPermission } from '@/lib/api-helpers';
import { changeStatusSchema } from '@/lib/validators/project';
import { getProject, changeProjectStatus } from '@/services/project.service';
import { recordAuditLog } from '@/services/audit.service';

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { projectId } = await params;
  const forbidden = await checkProjectPermission(user, projectId, 'project:change_status');
  if (forbidden) return forbidden;

  const body = await req.json();
  const parsed = changeStatusSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', details: parsed.error.issues } },
      { status: 400 },
    );
  }

  try {
    const before = await getProject(projectId);
    const project = await changeProjectStatus(projectId, parsed.data.status, user.id);

    await recordAuditLog({
      userId: user.id,
      action: 'UPDATE',
      entityType: 'project',
      entityId: projectId,
      beforeValue: { status: before?.status },
      afterValue: { status: project.status },
    });

    return NextResponse.json({ data: project });
  } catch (e) {
    if (e instanceof Error) {
      if (e.message === 'NOT_FOUND') {
        return NextResponse.json(
          { error: { code: 'NOT_FOUND', message: '対象が見つかりません' } },
          { status: 404 },
        );
      }
      if (e.message.startsWith('STATE_CONFLICT:')) {
        return NextResponse.json(
          { error: { code: 'STATE_CONFLICT', message: e.message.replace('STATE_CONFLICT:', '') } },
          { status: 409 },
        );
      }
    }
    throw e;
  }
}
