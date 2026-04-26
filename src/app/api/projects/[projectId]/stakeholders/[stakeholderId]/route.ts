/**
 * GET    /api/projects/[projectId]/stakeholders/[stakeholderId] - 単一取得
 * PATCH  /api/projects/[projectId]/stakeholders/[stakeholderId] - 編集
 * DELETE /api/projects/[projectId]/stakeholders/[stakeholderId] - 論理削除
 *
 * 認可: stakeholder:read / stakeholder:update / stakeholder:delete (admin / pm_tl のみ)。
 * 監査: PATCH/DELETE 時に audit_logs に before/after を記録。
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser, checkProjectPermission } from '@/lib/api-helpers';
import { updateStakeholderSchema } from '@/lib/validators/stakeholder';
import {
  getStakeholder,
  updateStakeholder,
  deleteStakeholder,
} from '@/services/stakeholder.service';
import { recordAuditLog, sanitizeForAudit } from '@/services/audit.service';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ projectId: string; stakeholderId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;
  const { projectId, stakeholderId } = await params;
  const forbidden = await checkProjectPermission(user, projectId, 'stakeholder:read');
  if (forbidden) return forbidden;

  const stakeholder = await getStakeholder(stakeholderId);
  if (!stakeholder || stakeholder.projectId !== projectId) {
    return NextResponse.json({ error: { code: 'NOT_FOUND' } }, { status: 404 });
  }
  return NextResponse.json({ data: stakeholder });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string; stakeholderId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;
  const { projectId, stakeholderId } = await params;

  const existing = await getStakeholder(stakeholderId);
  if (!existing || existing.projectId !== projectId) {
    return NextResponse.json({ error: { code: 'NOT_FOUND' } }, { status: 404 });
  }

  const forbidden = await checkProjectPermission(user, projectId, 'stakeholder:update');
  if (forbidden) return forbidden;

  const body = await req.json();
  const parsed = updateStakeholderSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', details: parsed.error.issues } },
      { status: 400 },
    );
  }

  let stakeholder;
  try {
    stakeholder = await updateStakeholder(stakeholderId, parsed.data, user.id);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === 'NOT_FOUND') {
      return NextResponse.json({ error: { code: 'NOT_FOUND' } }, { status: 404 });
    }
    throw e;
  }

  await recordAuditLog({
    userId: user.id,
    action: 'UPDATE',
    entityType: 'stakeholder',
    entityId: stakeholderId,
    beforeValue: sanitizeForAudit(existing as unknown as Record<string, unknown>),
    afterValue: sanitizeForAudit(stakeholder as unknown as Record<string, unknown>),
  });

  return NextResponse.json({ data: stakeholder });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ projectId: string; stakeholderId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;
  const { projectId, stakeholderId } = await params;

  const forbidden = await checkProjectPermission(user, projectId, 'stakeholder:delete');
  if (forbidden) return forbidden;

  const existing = await getStakeholder(stakeholderId);
  if (!existing || existing.projectId !== projectId) {
    return NextResponse.json({ error: { code: 'NOT_FOUND' } }, { status: 404 });
  }

  try {
    await deleteStakeholder(stakeholderId, user.id);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === 'NOT_FOUND') {
      return NextResponse.json({ error: { code: 'NOT_FOUND' } }, { status: 404 });
    }
    throw e;
  }

  await recordAuditLog({
    userId: user.id,
    action: 'DELETE',
    entityType: 'stakeholder',
    entityId: stakeholderId,
    beforeValue: sanitizeForAudit(existing as unknown as Record<string, unknown>),
  });

  return NextResponse.json({ data: { success: true } });
}
