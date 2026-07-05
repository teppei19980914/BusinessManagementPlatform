/**
 * PATCH  /idea/whiteboard/[sessionId]/notes/[noteId]  — 付箋更新（投稿者のみ）
 * DELETE /idea/whiteboard/[sessionId]/notes/[noteId]  — 付箋削除（投稿者のみ）
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  getAuthenticatedUser,
  checkProjectPermission,
  requireActualProjectMember,
} from '@/lib/api-helpers';
import { updateWhiteboardNoteSchema } from '@/lib/validators/idea-session';
import { updateNote, deleteNote } from '@/services/idea-whiteboard.service';

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string; sessionId: string; noteId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { projectId, noteId } = await params;
  const memberOnly = await requireActualProjectMember(user, projectId);
  if (memberOnly) return memberOnly;
  const forbidden = await checkProjectPermission(user, projectId, 'idea:submit');
  if (forbidden) return forbidden;

  const body = await req.json();
  const parsed = updateWhiteboardNoteSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', details: parsed.error.issues } },
      { status: 400 },
    );
  }

  let note;
  try {
    note = await updateNote(noteId, parsed.data, user.id, user.tenantId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === 'NOT_FOUND') {
      return NextResponse.json({ error: { code: 'NOT_FOUND' } }, { status: 404 });
    }
    if (msg === 'FORBIDDEN') {
      return NextResponse.json({ error: { code: 'FORBIDDEN' } }, { status: 403 });
    }
    if (msg === 'SESSION_CLOSED') {
      return NextResponse.json({ error: { code: 'SESSION_CLOSED' } }, { status: 409 });
    }
    throw e;
  }

  return NextResponse.json({ data: note });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ projectId: string; sessionId: string; noteId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { projectId, noteId } = await params;
  const memberOnly = await requireActualProjectMember(user, projectId);
  if (memberOnly) return memberOnly;
  const forbidden = await checkProjectPermission(user, projectId, 'idea:manage');
  if (forbidden) return forbidden;

  try {
    await deleteNote(noteId, user.id, user.tenantId);
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

  return new NextResponse(null, { status: 204 });
}
