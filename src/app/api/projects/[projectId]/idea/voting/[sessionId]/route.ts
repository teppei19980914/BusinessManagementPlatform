/**
 * GET    /api/projects/[projectId]/idea/voting/[sessionId]  — セッション単件取得
 * DELETE /api/projects/[projectId]/idea/voting/[sessionId]  — セッション削除（作成者のみ）
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  getAuthenticatedUser,
  checkProjectPermission,
  requireActualProjectMember,
} from '@/lib/api-helpers';
import { getVotingSession, deleteVotingSession } from '@/services/idea-voting.service';
import { deleteIdeaAssetLinksForSource } from '@/services/idea-asset-link.service';
import { recordAuditLog } from '@/services/audit.service';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ projectId: string; sessionId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { projectId, sessionId } = await params;
  const forbidden = await checkProjectPermission(user, projectId, 'idea:read');
  if (forbidden) return forbidden;

  try {
    const session = await getVotingSession(sessionId, user.id, user.tenantId);
    return NextResponse.json({ data: session });
  } catch (e) {
    if (e instanceof Error && e.message === 'NOT_FOUND') {
      return NextResponse.json({ error: { code: 'NOT_FOUND' } }, { status: 404 });
    }
    throw e;
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ projectId: string; sessionId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { projectId, sessionId } = await params;
  const memberOnly = await requireActualProjectMember(user, projectId);
  if (memberOnly) return memberOnly;
  const forbidden = await checkProjectPermission(user, projectId, 'idea:manage');
  if (forbidden) return forbidden;

  try {
    await deleteVotingSession(sessionId, user.id, user.tenantId);
    await deleteIdeaAssetLinksForSource('voting_session', sessionId, user.tenantId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === 'NOT_FOUND') {
      return NextResponse.json({ error: { code: 'NOT_FOUND' } }, { status: 404 });
    }
    if (msg === 'FORBIDDEN') {
      return NextResponse.json({ error: { code: 'FORBIDDEN' } }, { status: 403 });
    }
    throw e;
  }

  await recordAuditLog({
    tenantId: user.tenantId,
    userId: user.id,
    action: 'DELETE',
    entityType: 'idea_voting_session',
    entityId: sessionId,
  });

  return new NextResponse(null, { status: 204 });
}
