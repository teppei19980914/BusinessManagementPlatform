import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser, checkProjectPermission } from '@/lib/api-helpers';
import { updateEstimateSchema } from '@/lib/validators/estimate';
import { getEstimate, updateEstimate, confirmEstimate, deleteEstimate } from '@/services/estimate.service';
import { recordAuditLog, sanitizeForAudit } from '@/services/audit.service';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ projectId: string; estimateId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { projectId, estimateId } = await params;
  const forbidden = await checkProjectPermission(user, projectId, 'project:read');
  if (forbidden) return forbidden;

  const estimate = await getEstimate(estimateId);
  if (!estimate || estimate.projectId !== projectId) {
    return NextResponse.json({ error: { code: 'NOT_FOUND' } }, { status: 404 });
  }

  return NextResponse.json({ data: estimate });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string; estimateId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { projectId, estimateId } = await params;
  const forbidden = await checkProjectPermission(user, projectId, 'project:update');
  if (forbidden) return forbidden;

  const existing = await getEstimate(estimateId);
  if (!existing || existing.projectId !== projectId) {
    return NextResponse.json({ error: { code: 'NOT_FOUND' } }, { status: 404 });
  }

  const body = await req.json();

  // 確定アクション
  if (body.action === 'confirm') {
    const estimate = await confirmEstimate(estimateId, user.id);
    await recordAuditLog({
      userId: user.id,
      action: 'UPDATE',
      entityType: 'estimate',
      entityId: estimateId,
      beforeValue: { isConfirmed: false },
      afterValue: { isConfirmed: true },
    });
    return NextResponse.json({ data: estimate });
  }

  const parsed = updateEstimateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', details: parsed.error.issues } },
      { status: 400 },
    );
  }

  if (existing.isConfirmed) {
    return NextResponse.json(
      { error: { code: 'STATE_CONFLICT', message: '確定済みの見積もりは編集できません' } },
      { status: 409 },
    );
  }

  const estimate = await updateEstimate(estimateId, parsed.data, user.id);

  await recordAuditLog({
    userId: user.id,
    action: 'UPDATE',
    entityType: 'estimate',
    entityId: estimateId,
    beforeValue: sanitizeForAudit(existing as unknown as Record<string, unknown>),
    afterValue: sanitizeForAudit(estimate as unknown as Record<string, unknown>),
  });

  return NextResponse.json({ data: estimate });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ projectId: string; estimateId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { projectId, estimateId } = await params;
  const forbidden = await checkProjectPermission(user, projectId, 'project:update');
  if (forbidden) return forbidden;

  const existing = await getEstimate(estimateId);
  if (!existing || existing.projectId !== projectId) {
    return NextResponse.json({ error: { code: 'NOT_FOUND' } }, { status: 404 });
  }

  await deleteEstimate(estimateId, user.id);

  await recordAuditLog({
    userId: user.id,
    action: 'DELETE',
    entityType: 'estimate',
    entityId: estimateId,
    beforeValue: sanitizeForAudit(existing as unknown as Record<string, unknown>),
  });

  return NextResponse.json({ data: { success: true } });
}
