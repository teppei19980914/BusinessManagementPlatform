/**
 * GET  /api/projects/[projectId]/members - プロジェクトメンバー一覧取得
 * POST /api/projects/[projectId]/members - メンバー追加 (システム管理者のみ)
 *
 * 役割:
 *   メンバー管理画面の表示と新規追加。GET は WBS / リスク等の担当者
 *   ドロップダウン用にも参照される。
 *
 * 認可:
 *   - GET: project:read (担当者選択 UI のためメンバー全員に許可)
 *   - POST: requireAdmin (権限委譲リスク回避でシステム管理者のみ)
 *
 * 監査: POST 時に audit_logs と role_change_logs に記録。
 *
 * 関連: DESIGN.md §8 (権限制御 - メンバー管理)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from 'next-intl/server';
import { getAuthenticatedUser, checkProjectPermission, requireAdmin } from '@/lib/api-helpers';
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

  const members = await listMembers(projectId);
  return NextResponse.json({ data: members });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const forbidden = requireAdmin(user);
  if (forbidden) return forbidden;

  const { projectId } = await params;
  const body = await req.json();
  const parsed = addMemberSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', details: parsed.error.issues } },
      { status: 400 },
    );
  }

  try {
    const member = await addMember(
      projectId,
      parsed.data.userId,
      parsed.data.projectRole,
      user.id,
    );

    await recordAuditLog({
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
    }
    throw e;
  }
}
