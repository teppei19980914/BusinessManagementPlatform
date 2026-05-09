/**
 * POST/DELETE /api/projects/:projectId/retrospectives/:retroId/link
 *
 * PR feat/asset-multi-project-linking (2026-05-09 / Phase 1):
 *   別プロジェクトの振り返りを自プロジェクトに紐付け / 解除する。
 *
 * 認可: 自プロジェクトのメンバー (member/pm_tl/admin) であること。
 *   - 既存の retro CREATE/UPDATE は project:update (PM/TL+admin) だが、
 *     **link は member 全員で許可** (ユーザ要件: 「対象プロジェクトのメンバー全員」)。
 *   - 厳密な permission action がないため `risk:update` (member-level) を流用。
 *     これは「資産の link/unlink は member 共通動作」という統一原則の実装上の表現。
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser, checkProjectPermission } from '@/lib/api-helpers';
import {
  linkRetrospectiveToProject,
  unlinkRetrospectiveFromProject,
} from '@/services/retrospective.service';
import { recordAuditLog } from '@/services/audit.service';

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ projectId: string; retroId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { projectId, retroId } = await params;
  const forbidden = await checkProjectPermission(user, projectId, 'risk:update');
  if (forbidden) return forbidden;

  try {
    const result = await linkRetrospectiveToProject(retroId, projectId);
    if (result.added) {
      await recordAuditLog({
        userId: user.id,
        action: 'CREATE',
        entityType: 'retrospective_project',
        entityId: retroId,
        afterValue: { retrospectiveId: retroId, projectId },
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
  { params }: { params: Promise<{ projectId: string; retroId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { projectId, retroId } = await params;
  const forbidden = await checkProjectPermission(user, projectId, 'risk:update');
  if (forbidden) return forbidden;

  const result = await unlinkRetrospectiveFromProject(retroId, projectId);
  if (result.removed) {
    await recordAuditLog({
      userId: user.id,
      action: 'DELETE',
      entityType: 'retrospective_project',
      entityId: retroId,
      beforeValue: { retrospectiveId: retroId, projectId },
    });
  }
  return NextResponse.json({ data: result });
}
