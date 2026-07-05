/**
 * POST /idea/qa/[threadId]/close  — Q&A スレッド解消（投稿者のみ）
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  getAuthenticatedUser,
  checkProjectPermission,
  requireActualProjectMember,
} from '@/lib/api-helpers';
import { closeQaThread } from '@/services/idea-qa.service';
import { recordAuditLog } from '@/services/audit.service';

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ projectId: string; threadId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { projectId, threadId } = await params;
  const memberOnly = await requireActualProjectMember(user, projectId);
  if (memberOnly) return memberOnly;
  const forbidden = await checkProjectPermission(user, projectId, 'idea:submit');
  if (forbidden) return forbidden;

  let thread;
  try {
    thread = await closeQaThread(threadId, user.id, user.tenantId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === 'NOT_FOUND') {
      return NextResponse.json({ error: { code: 'NOT_FOUND' } }, { status: 404 });
    }
    if (msg === 'FORBIDDEN') {
      return NextResponse.json(
        { error: { code: 'FORBIDDEN', message: '質問の投稿者のみ解消できます' } },
        { status: 403 },
      );
    }
    if (msg === 'ALREADY_CLOSED') {
      return NextResponse.json({ error: { code: 'ALREADY_CLOSED' } }, { status: 409 });
    }
    throw e;
  }

  await recordAuditLog({
    tenantId: user.tenantId,
    userId: user.id,
    action: 'UPDATE',
    entityType: 'idea_qa_thread',
    entityId: threadId,
    afterValue: { status: 'closed' },
  });

  return NextResponse.json({ data: thread });
}
