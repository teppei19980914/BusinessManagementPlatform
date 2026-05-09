/**
 * POST/DELETE /api/projects/:projectId/risks/:riskId/link
 *
 * PR feat/asset-multi-project-linking (2026-05-09 / Phase 1):
 *   別プロジェクト (作成元 A) のリスク/課題を、自プロジェクト (B) に紐付け / 解除する。
 *
 *   POST   = 紐付け追加 (idempotent)
 *   DELETE = 紐付け解除 (idempotent / 本体は削除しない)
 *
 * 認可: 自プロジェクト (params.projectId = B) のメンバー (member/pm_tl/admin) であること。
 *   `risk:update` 権限を流用 (member-level)。viewer は不可。
 *   操作対象 risk が public でなくとも、メンバー権限さえあればここでは許可
 *   (UI 側で「参考」タブ提示時に visibility=public のみを候補としているため)。
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser, checkProjectPermission } from '@/lib/api-helpers';
import { linkRiskToProject, unlinkRiskFromProject } from '@/services/risk.service';
import { recordAuditLog } from '@/services/audit.service';

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ projectId: string; riskId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { projectId, riskId } = await params;
  // member 以上 (viewer 不可) を確認
  const forbidden = await checkProjectPermission(user, projectId, 'risk:update');
  if (forbidden) return forbidden;

  try {
    const result = await linkRiskToProject(riskId, projectId);
    if (result.added) {
      await recordAuditLog({
        userId: user.id,
        action: 'CREATE',
        entityType: 'risk_issue_project',
        entityId: riskId,
        afterValue: { riskIssueId: riskId, projectId },
      });
    }
    return NextResponse.json({ data: result }, { status: result.added ? 201 : 200 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === 'NOT_FOUND') {
      return NextResponse.json({ error: { code: 'NOT_FOUND' } }, { status: 404 });
    }
    if (msg === 'PROJECT_NOT_FOUND') {
      return NextResponse.json({ error: { code: 'PROJECT_NOT_FOUND' } }, { status: 404 });
    }
    if (msg === 'TENANT_MISMATCH') {
      return NextResponse.json({ error: { code: 'TENANT_MISMATCH' } }, { status: 403 });
    }
    throw e;
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ projectId: string; riskId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { projectId, riskId } = await params;
  const forbidden = await checkProjectPermission(user, projectId, 'risk:update');
  if (forbidden) return forbidden;

  const result = await unlinkRiskFromProject(riskId, projectId, user.tenantId);
  if (result.removed) {
    await recordAuditLog({
      userId: user.id,
      action: 'DELETE',
      entityType: 'risk_issue_project',
      entityId: riskId,
      beforeValue: { riskIssueId: riskId, projectId },
    });
  }
  return NextResponse.json({ data: result });
}
