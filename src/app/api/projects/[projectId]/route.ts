import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser, checkProjectPermission } from '@/lib/api-helpers';
import { updateProjectSchema } from '@/lib/validators/project';
import { getProject, updateProject, deleteProject } from '@/services/project.service';
import { recordAuditLog, sanitizeForAudit } from '@/services/audit.service';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { projectId } = await params;
  const forbidden = await checkProjectPermission(user, projectId, 'project:read');
  if (forbidden) return forbidden;

  const project = await getProject(projectId);
  if (!project) {
    return NextResponse.json(
      { error: { code: 'NOT_FOUND', message: '対象が見つかりません' } },
      { status: 404 },
    );
  }

  return NextResponse.json({ data: project });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { projectId } = await params;
  const forbidden = await checkProjectPermission(user, projectId, 'project:update');
  if (forbidden) return forbidden;

  const body = await req.json();
  const parsed = updateProjectSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', details: parsed.error.issues } },
      { status: 400 },
    );
  }

  const before = await getProject(projectId);
  const project = await updateProject(projectId, parsed.data, user.id);

  await recordAuditLog({
    userId: user.id,
    action: 'UPDATE',
    entityType: 'project',
    entityId: projectId,
    beforeValue: before ? sanitizeForAudit(before as unknown as Record<string, unknown>) : null,
    afterValue: sanitizeForAudit(project as unknown as Record<string, unknown>),
  });

  return NextResponse.json({ data: project });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { projectId } = await params;
  const forbidden = await checkProjectPermission(user, projectId, 'project:delete');
  if (forbidden) return forbidden;

  const before = await getProject(projectId);
  await deleteProject(projectId, user.id);

  await recordAuditLog({
    userId: user.id,
    action: 'DELETE',
    entityType: 'project',
    entityId: projectId,
    beforeValue: before ? sanitizeForAudit(before as unknown as Record<string, unknown>) : null,
  });

  return NextResponse.json({ data: { success: true } });
}
