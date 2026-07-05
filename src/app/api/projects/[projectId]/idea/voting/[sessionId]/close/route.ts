/**
 * POST /api/projects/[projectId]/idea/voting/[sessionId]/close  — セッション手動クローズ（作成者のみ）
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  getAuthenticatedUser,
  checkProjectPermission,
  requireActualProjectMember,
} from '@/lib/api-helpers';
import { closeVotingSession } from '@/services/idea-voting.service';
import { recordAuditLog } from '@/services/audit.service';

export async function POST(
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

  let session;
  try {
    session = await closeVotingSession(sessionId, user.id, user.tenantId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === 'NOT_FOUND') {
      return NextResponse.json({ error: { code: 'NOT_FOUND' } }, { status: 404 });
    }
    if (msg === 'FORBIDDEN') {
      return NextResponse.json(
        { error: { code: 'FORBIDDEN', message: 'セッション作成者のみクローズできます' } },
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
    entityType: 'idea_voting_session',
    entityId: sessionId,
    afterValue: { status: 'closed' },
  });

  return NextResponse.json({ data: session });
}
