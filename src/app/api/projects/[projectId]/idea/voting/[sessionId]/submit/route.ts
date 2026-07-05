/**
 * POST /api/projects/[projectId]/idea/voting/[sessionId]/submit  — 投票提出 (UPSERT)
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  getAuthenticatedUser,
  checkProjectPermission,
  requireActualProjectMember,
} from '@/lib/api-helpers';
import { submitVoteSchema } from '@/lib/validators/idea-session';
import { submitVote } from '@/services/idea-voting.service';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string; sessionId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { projectId, sessionId } = await params;
  const memberOnly = await requireActualProjectMember(user, projectId);
  if (memberOnly) return memberOnly;
  const forbidden = await checkProjectPermission(user, projectId, 'idea:submit');
  if (forbidden) return forbidden;

  const body = await req.json();
  const parsed = submitVoteSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', details: parsed.error.issues } },
      { status: 400 },
    );
  }

  let session;
  try {
    session = await submitVote(sessionId, parsed.data, user.id, user.tenantId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === 'NOT_FOUND') {
      return NextResponse.json({ error: { code: 'NOT_FOUND' } }, { status: 404 });
    }
    if (msg === 'SESSION_CLOSED') {
      return NextResponse.json({ error: { code: 'SESSION_CLOSED' } }, { status: 409 });
    }
    if (msg === 'DOT_VOTES_EXCEEDED') {
      return NextResponse.json(
        { error: { code: 'DOT_VOTES_EXCEEDED', message: '投票数が上限を超えています' } },
        { status: 400 },
      );
    }
    throw e;
  }

  return NextResponse.json({ data: session });
}
