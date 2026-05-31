/**
 * GET  /api/projects/[projectId]/members - プロジェクトメンバー一覧取得
 * POST /api/projects/[projectId]/members - メンバー追加 (PM/TL + admin)
 *
 * 役割:
 *   メンバー管理画面の表示と新規追加。GET は WBS / リスク等の担当者
 *   ドロップダウン用にも参照される。
 *
 * 認可:
 *   - GET:  project:read     (担当者選択 UI のためメンバー全員に許可)
 *   - POST: member:manage    (PM/TL + admin)。ただし projectRole='pm_tl' の追加は
 *                            service 層で admin/super_admin のみに細粒度ガード。
 *                            feat/crud-permission-redesign (2026-05-20) で開放。
 *
 * 監査: POST 時に audit_logs と role_change_logs に記録。
 *
 * 関連: DESIGN.md §8 (権限制御 - メンバー管理)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from 'next-intl/server';
import {
  getAuthenticatedUser,
  checkProjectPermission,
  requireStorageQuotaForWrite,
} from '@/lib/api-helpers';
import { listMembers, addMember } from '@/services/member.service';
import { recordAuditLog } from '@/services/audit.service';
import { z } from 'zod/v4';

const addMemberSchema = z.object({
  userId: z.string().uuid(),
  projectRole: z.enum(['pm_tl', 'member', 'viewer']),
});

// GET: 担当者ドロップダウンや WBS/リスクタブでメンバー一覧を参照するため、
// プロジェクトメンバー全員に許可（従来 SSR の page.tsx で listMembers を全員に配布していたのと同等）
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { projectId } = await params;
  const forbidden = await checkProjectPermission(user, projectId, 'project:read');
  if (forbidden) return forbidden;

  const members = await listMembers(projectId, user.tenantId);
  return NextResponse.json({ data: members });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { projectId } = await params;
  // feat/crud-permission-redesign (2026-05-20): admin 限定から member:manage (PM/TL + admin) に開放。
  //   PM/TL 自身が projectRole='pm_tl' を追加することは service 層で FORBIDDEN_PMTL_ROLE として弾く。
  const forbidden = await checkProjectPermission(user, projectId, 'member:manage');
  if (forbidden) return forbidden;

  const body = await req.json();
  const parsed = addMemberSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', details: parsed.error.issues } },
      { status: 400 },
    );
  }

  // PR-5 (2026-05-15): ストレージ容量 Pre-check
  const quotaErr = await requireStorageQuotaForWrite(
    user.tenantId,
    Buffer.byteLength(JSON.stringify(parsed.data), 'utf8'),
  );
  if (quotaErr) return quotaErr;

  try {
    const member = await addMember(
      projectId,
      parsed.data.userId,
      parsed.data.projectRole,
      user.id,
      user.tenantId,
      user.systemRole,
    );

    await recordAuditLog({
      tenantId: user.tenantId,
      userId: user.id,
      action: 'CREATE',
      entityType: 'project_member',
      entityId: member.id,
      afterValue: { projectId, userId: parsed.data.userId, projectRole: parsed.data.projectRole },
    });

    return NextResponse.json({ data: member }, { status: 201 });
  } catch (e) {
    if (e instanceof Error) {
      if (e.message === 'USER_NOT_FOUND') {
        const t = await getTranslations('message');
        return NextResponse.json(
          { error: { code: 'NOT_FOUND', message: t('userNotFound') } },
          { status: 404 },
        );
      }
      if (e.message === 'ALREADY_MEMBER') {
        const t = await getTranslations('message');
        return NextResponse.json(
          { error: { code: 'VALIDATION_ERROR', message: t('alreadyMember') } },
          { status: 409 },
        );
      }
      // feat/crud-permission-redesign (2026-05-20): PM/TL ロール操作の細粒度ガード違反
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
