import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser, checkProjectPermission } from '@/lib/api-helpers';
import { createRetrospectiveSchema } from '@/lib/validators/retrospective';
import { listRetrospectives, createRetrospective } from '@/services/retrospective.service';
import { recordAuditLog } from '@/services/audit.service';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;
  const { projectId } = await params;
  const forbidden = await checkProjectPermission(user, projectId, 'project:read');
  if (forbidden) return forbidden;
  const retros = await listRetrospectives(projectId);
  return NextResponse.json({ data: retros });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;
  const { projectId } = await params;
  const forbidden = await checkProjectPermission(user, projectId, 'project:update');
  if (forbidden) return forbidden;

  const body = await req.json();
  const parsed = createRetrospectiveSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: { code: 'VALIDATION_ERROR', details: parsed.error.issues } }, { status: 400 });
  }

  const retro = await createRetrospective(projectId, parsed.data, user.id);
  await recordAuditLog({ userId: user.id, action: 'CREATE', entityType: 'retrospective', entityId: retro.id });
  return NextResponse.json({ data: retro }, { status: 201 });
}
