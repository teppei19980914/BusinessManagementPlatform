/**
 * GET    /api/projects/[projectId]/risks/[riskId] - 単一リスク/課題取得
 * PATCH  /api/projects/[projectId]/risks/[riskId] - 編集
 * DELETE /api/projects/[projectId]/risks/[riskId] - 論理削除
 *
 * 認可: checkProjectPermission ('risk:read' / 'risk:edit' / 'risk:delete')
 * 監査: PATCH/DELETE 時に audit_logs に before/after を記録。
 *
 * 関連: DESIGN.md §8.3 (権限制御 — risk アクション)
 */

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
  // 2026-04-24: draft は作成者/admin のみ参照可。他人の draft は null が返る。
  const risk = await getRisk(riskId, user.id, user.systemRole);
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

  // 2026-04-24: 内部呼び出し (既存検証) は認可引数なしで取得。FORBIDDEN 判定は service 層で実施。
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

  let risk;
  try {
    risk = await updateRisk(riskId, parsed.data, user.id);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === 'FORBIDDEN') {
      return NextResponse.json(
        { error: { code: 'FORBIDDEN', message: '作成者本人のみ編集できます' } },
        { status: 403 },
      );
    }
    if (msg === 'NOT_FOUND') {
      return NextResponse.json({ error: { code: 'NOT_FOUND' } }, { status: 404 });
    }
    throw e;
  }
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
  // 2026-04-24: ProjectMember 基準の permission は read 確認のみに使用 (admin は常に通過)。
  //             作成者本人 or admin の判定は service 層で厳格に実施する。
  const forbidden = await checkProjectPermission(user, projectId, 'risk:read');
  if (forbidden) return forbidden;
  const existing = await getRisk(riskId);
  if (!existing || existing.projectId !== projectId) {
    return NextResponse.json({ error: { code: 'NOT_FOUND' } }, { status: 404 });
  }
  try {
    await deleteRisk(riskId, user.id, user.systemRole);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === 'FORBIDDEN') {
      return NextResponse.json(
        { error: { code: 'FORBIDDEN', message: '作成者本人または管理者のみ削除できます' } },
        { status: 403 },
      );
    }
    if (msg === 'NOT_FOUND') {
      return NextResponse.json({ error: { code: 'NOT_FOUND' } }, { status: 404 });
    }
    throw e;
  }
  await recordAuditLog({
    userId: user.id,
    action: 'DELETE',
    entityType: 'risk_issue',
    entityId: riskId,
    beforeValue: sanitizeForAudit(existing as unknown as Record<string, unknown>),
  });
  return NextResponse.json({ data: { success: true } });
}
