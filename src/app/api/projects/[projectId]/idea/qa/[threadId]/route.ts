/**
 * GET    /idea/qa/[threadId]  — スレッド単件取得
 * DELETE /idea/qa/[threadId]  — スレッド削除（投稿者のみ）
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  getAuthenticatedUser,
  checkProjectPermission,
  requireActualProjectMember,
} from '@/lib/api-helpers';
import { getQaThread, deleteQaThread } from '@/services/idea-qa.service';
import { deleteIdeaAssetLinksForSource } from '@/services/idea-asset-link.service';
import { recordAuditLog } from '@/services/audit.service';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ projectId: string; threadId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { projectId, threadId } = await params;
  const forbidden = await checkProjectPermission(user, projectId, 'idea:read');
  if (forbidden) return forbidden;

  try {
    const thread = await getQaThread(threadId, user.id, user.tenantId);
    return NextResponse.json({ data: thread });
  } catch (e) {
    if (e instanceof Error && e.message === 'NOT_FOUND') {
      return NextResponse.json({ error: { code: 'NOT_FOUND' } }, { status: 404 });
    }
    throw e;
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ projectId: string; threadId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { projectId, threadId } = await params;
  const memberOnly = await requireActualProjectMember(user, projectId);
  if (memberOnly) return memberOnly;
  const forbidden = await checkProjectPermission(user, projectId, 'idea:manage');
  if (forbidden) return forbidden;

  try {
    await deleteQaThread(threadId, user.id, user.tenantId);
    await deleteIdeaAssetLinksForSource('qa_thread', threadId, user.tenantId);
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
    entityType: 'idea_qa_thread',
    entityId: threadId,
  });

  return new NextResponse(null, { status: 204 });
}
