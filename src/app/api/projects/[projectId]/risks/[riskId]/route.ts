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
import { getTranslations } from 'next-intl/server';
import {
  getAuthenticatedUser,
  checkProjectPermission,
  requireStorageQuotaForWrite,
} from '@/lib/api-helpers';
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
  const risk = await getRisk(riskId, user.id, user.systemRole, user.tenantId);
  // PR feat/asset-multi-project-linking: 「このプロジェクトに紐付け済」かを linkedProjectIds で判定
  if (!risk || !risk.linkedProjectIds.includes(projectId)) {
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
  // 2026-05-09 feedback Phase 2-3: 越境編集対象の存在確認を含めて防御するため tenantId を渡す。
  const existing = await getRisk(riskId, undefined, undefined, user.tenantId);
  // PR feat/asset-multi-project-linking: 紐付け判定は linkedProjectIds 経由
  if (!existing || !existing.linkedProjectIds.includes(projectId)) {
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

  // PR-5 (2026-05-15): ストレージ容量 Pre-check
  const quotaErr = await requireStorageQuotaForWrite(
    user.tenantId,
    JSON.stringify(parsed.data).length,
  );
  if (quotaErr) return quotaErr;

  let risk;
  try {
    risk = await updateRisk(riskId, parsed.data, user.id, user.tenantId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === 'FORBIDDEN') {
      const t = await getTranslations('message');
      return NextResponse.json(
        { error: { code: 'FORBIDDEN', message: t('creatorOnlyEdit') } },
        { status: 403 },
      );
    }
    if (msg === 'NOT_FOUND') {
      return NextResponse.json({ error: { code: 'NOT_FOUND' } }, { status: 404 });
    }
    // 2026-05-11 defense-in-depth: 「全メンバー」化を試みたが title が空 (input + DB 共に) のケース
    if (msg === 'PUBLIC_REQUIRES_TITLE') {
      return NextResponse.json(
        {
          error: {
            code: 'PUBLIC_REQUIRES_TITLE',
            message: '「全メンバー」に公開する場合は件名を入力してください',
          },
        },
        { status: 400 },
      );
    }
    throw e;
  }
  await recordAuditLog({
    tenantId: user.tenantId,
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
  const existing = await getRisk(riskId, undefined, undefined, user.tenantId);
  // PR feat/asset-multi-project-linking: 紐付け判定は linkedProjectIds 経由
  if (!existing || !existing.linkedProjectIds.includes(projectId)) {
    return NextResponse.json({ error: { code: 'NOT_FOUND' } }, { status: 404 });
  }
  try {
    // feat/crud-permission-redesign (2026-05-20): project 経路は作成者本人のみ削除可。
    //   admin も「リスク/課題一覧」上では削除不可 (横断「全リスク/課題」経路で削除する)。
    await deleteRisk(riskId, user.id, user.systemRole, user.tenantId, 'project');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === 'FORBIDDEN') {
      const t = await getTranslations('message');
      return NextResponse.json(
        { error: { code: 'FORBIDDEN', message: t('creatorOrAdminOnlyDelete') } },
        { status: 403 },
      );
    }
    if (msg === 'NOT_FOUND') {
      return NextResponse.json({ error: { code: 'NOT_FOUND' } }, { status: 404 });
    }
    throw e;
  }
  await recordAuditLog({
    tenantId: user.tenantId,
    userId: user.id,
    action: 'DELETE',
    entityType: 'risk_issue',
    entityId: riskId,
    beforeValue: sanitizeForAudit(existing as unknown as Record<string, unknown>),
  });
  return NextResponse.json({ data: { success: true } });
}
