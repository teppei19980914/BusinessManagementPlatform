/**
 * POST /idea/qa/[threadId]/upvote  — いいねトグル
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  getAuthenticatedUser,
  checkProjectPermission,
  requireActualProjectMember,
} from '@/lib/api-helpers';
import { toggleUpvote } from '@/services/idea-qa.service';

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

  try {
    const result = await toggleUpvote(threadId, user.id, user.tenantId);
    return NextResponse.json({ data: result });
  } catch (e) {
    if (e instanceof Error && e.message === 'NOT_FOUND') {
      return NextResponse.json({ error: { code: 'NOT_FOUND' } }, { status: 404 });
    }
    throw e;
  }
}
