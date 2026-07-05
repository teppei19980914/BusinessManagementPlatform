/**
 * POST /idea/qa/[threadId]/answers  — 回答投稿（解消済みでも可）
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  getAuthenticatedUser,
  checkProjectPermission,
  requireActualProjectMember,
} from '@/lib/api-helpers';
import { createQaAnswerSchema } from '@/lib/validators/idea-session';
import { createAnswer } from '@/services/idea-qa.service';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string; threadId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { projectId, threadId } = await params;
  const memberOnly = await requireActualProjectMember(user, projectId);
  if (memberOnly) return memberOnly;
  const forbidden = await checkProjectPermission(user, projectId, 'idea:submit');
  if (forbidden) return forbidden;

  const body = await req.json();
  const parsed = createQaAnswerSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', details: parsed.error.issues } },
      { status: 400 },
    );
  }

  let answer;
  try {
    answer = await createAnswer(threadId, parsed.data, user.id, user.tenantId);
  } catch (e) {
    if (e instanceof Error && e.message === 'NOT_FOUND') {
      return NextResponse.json({ error: { code: 'NOT_FOUND' } }, { status: 404 });
    }
    throw e;
  }

  return NextResponse.json({ data: answer }, { status: 201 });
}
