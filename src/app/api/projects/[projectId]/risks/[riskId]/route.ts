import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser, checkProjectPermission } from '@/lib/api-helpers';
import { updateRiskSchema } from '@/lib/validators/risk';
import { getRisk, updateRisk, deleteRisk } from '@/services/risk.service';
import { recordAuditLog, sanitizeForAudit } from '@/services/audit.service';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ projectId: string; riskId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;
  const { projectId, riskId } = await params;
  const forbidden = await checkProjectPermission(user, projectId, 'risk:read');
  if (forbidden) return forbidden;
  const risk = await getRisk(riskId);
  if (!risk || risk.projectId !== projectId) {
    return NextResponse.json({ error: { code: 'NOT_FOUND' } }, { status: 404 });
  }
  return NextResponse.json({ data: risk });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string; riskId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;
  const { projectId, riskId } = await params;

  const existing = await getRisk(riskId);
  if (!existing || existing.projectId !== projectId) {
    return NextResponse.json({ error: { code: 'NOT_FOUND' } }, { status: 404 });
  }

  const forbidden = await checkProjectPermission(user, projectId, 'risk:update', existing.reporterId);
  if (forbidden) return forbidden;

  const body = await req.json();
  const parsed = updateRiskSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', details: parsed.error.issues } },
      { status: 400 },
    );
  }

  const risk = await updateRisk(riskId, parsed.data, user.id);
  await recordAuditLog({
    userId: user.id,
    action: 'UPDATE',
    entityType: 'risk_issue',
    entityId: riskId,
    beforeValue: sanitizeForAudit(existing as unknown as Record<string, unknown>),
    afterValue: sanitizeForAudit(risk as unknown as Record<string, unknown>),
  });
  return NextResponse.json({ data: risk });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ projectId: string; riskId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;
  const { projectId, riskId } = await params;
  const forbidden = await checkProjectPermission(user, projectId, 'risk:delete');
  if (forbidden) return forbidden;
  const existing = await getRisk(riskId);
  if (!existing || existing.projectId !== projectId) {
    return NextResponse.json({ error: { code: 'NOT_FOUND' } }, { status: 404 });
  }
  await deleteRisk(riskId, user.id);
  await recordAuditLog({
    userId: user.id,
    action: 'DELETE',
    entityType: 'risk_issue',
    entityId: riskId,
    beforeValue: sanitizeForAudit(existing as unknown as Record<string, unknown>),
  });
  return NextResponse.json({ data: { success: true } });
}
