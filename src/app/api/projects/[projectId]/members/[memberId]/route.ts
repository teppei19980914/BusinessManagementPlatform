/**
 * PATCH  /api/projects/[id]/members/[memberId] - ロール変更 (PM/TL ↔ メンバー ↔ 閲覧者)
 * DELETE /api/projects/[id]/members/[memberId] - メンバー除外
 *
 * 役割:
 *   プロジェクトメンバーのロール変更/除外。除外は物理削除 (member.service の判断)。
 *   ロール変更は role_change_logs にも履歴記録される。
 *
 * 認可: member:manage (PM/TL + admin)。
 *   feat/crud-permission-redesign (2026-05-20) で admin 限定から PM/TL も実行可に開放。
 *   ただし「PM/TL ロール」を扱う操作 (PM/TL 削除・PM/TL↔それ以外のロール変更) は
 *   service 層で admin/super_admin のみに細粒度ガード (FORBIDDEN_PMTL_ROLE)。
 * 監査:
 *   - audit_logs (action=UPDATE/DELETE, entityType=project_member)
 *   - role_change_logs (changeType=project_role)
 *
 * 関連: DESIGN.md §8 (権限制御 - ロール変更履歴)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from 'next-intl/server';
import { getAuthenticatedUser, checkProjectPermission } from '@/lib/api-helpers';
import { updateMemberRole, removeMember } from '@/services/member.service';
import { recordAuditLog } from '@/services/audit.service';
import { z } from 'zod/v4';

const updateRoleSchema = z.object({
  projectRole: z.enum(['pm_tl', 'member', 'viewer']),
});

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string; memberId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { projectId, memberId } = await params;
  const forbidden = await checkProjectPermission(user, projectId, 'member:manage');
  if (forbidden) return forbidden;

  const body = await req.json();
  const parsed = updateRoleSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', details: parsed.error.issues } },
      { status: 400 },
    );
  }

  try {
    const member = await updateMemberRole(
      memberId,
      parsed.data.projectRole,
      user.id,
      user.tenantId,
      user.systemRole,
    );

    await recordAuditLog({
      tenantId: user.tenantId,
      userId: user.id,
      action: 'UPDATE',
      entityType: 'project_member',
      entityId: memberId,
      afterValue: { projectRole: parsed.data.projectRole },
    });

    return NextResponse.json({ data: member });
  } catch (e) {
    if (e instanceof Error) {
      if (e.message === 'NOT_FOUND') {
        const t = await getTranslations('message');
        return NextResponse.json(
          { error: { code: 'NOT_FOUND', message: t('memberNotFound') } },
          { status: 404 },
        );
      }
      if (e.message === 'FORBIDDEN_PMTL_ROLE') {
        const t = await getTranslations('message');
        return NextResponse.json(
          { error: { code: 'FORBIDDEN', message: t('cannotManagePmTl') } },
          { status: 403 },
        );
      }
    }
    throw e;
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ projectId: string; memberId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { projectId, memberId } = await params;
  const forbidden = await checkProjectPermission(user, projectId, 'member:manage');
  if (forbidden) return forbidden;

  try {
    await removeMember(memberId, user.id, user.tenantId, user.systemRole);

    await recordAuditLog({
      tenantId: user.tenantId,
      userId: user.id,
      action: 'DELETE',
      entityType: 'project_member',
      entityId: memberId,
    });

    return NextResponse.json({ data: { success: true } });
  } catch (e) {
    if (e instanceof Error) {
      if (e.message === 'NOT_FOUND') {
        const t = await getTranslations('message');
        return NextResponse.json(
          { error: { code: 'NOT_FOUND', message: t('memberNotFound') } },
          { status: 404 },
        );
      }
      if (e.message === 'FORBIDDEN_PMTL_ROLE') {
        const t = await getTranslations('message');
        return NextResponse.json(
          { error: { code: 'FORBIDDEN', message: t('cannotManagePmTl') } },
          { status: 403 },
        );
      }
    }
    throw e;
  }
}
