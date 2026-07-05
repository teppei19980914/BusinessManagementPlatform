/**
 * POST /idea/whiteboard/[sessionId]/notes  — 付箋投稿
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  getAuthenticatedUser,
  checkProjectPermission,
  requireActualProjectMember,
} from '@/lib/api-helpers';
import { createWhiteboardNoteSchema } from '@/lib/validators/idea-session';
import { createNote } from '@/services/idea-whiteboard.service';

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
  const parsed = createWhiteboardNoteSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', details: parsed.error.issues } },
      { status: 400 },
    );
  }

  let note;
  try {
    note = await createNote(sessionId, parsed.data, user.id, user.tenantId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === 'NOT_FOUND') {
      return NextResponse.json({ error: { code: 'NOT_FOUND' } }, { status: 404 });
    }
    if (msg === 'SESSION_CLOSED') {
      return NextResponse.json({ error: { code: 'SESSION_CLOSED' } }, { status: 409 });
    }
    throw e;
  }

  return NextResponse.json({ data: note }, { status: 201 });
}
