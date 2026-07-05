/**
 * GET  /api/projects/[projectId]/idea/voting  — 投票セッション一覧
 * POST /api/projects/[projectId]/idea/voting  — 投票セッション作成
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  getAuthenticatedUser,
  checkProjectPermission,
  requireActualProjectMember,
} from '@/lib/api-helpers';
import { createVotingSessionSchema, IDEA_SESSION_STATUSES } from '@/lib/validators/idea-session';
import { IDEA_VOTING_KINDS, type IdeaVotingKind } from '@/lib/validators/idea-session';
import { listVotingSessions, createVotingSession } from '@/services/idea-voting.service';
import { recordAuditLog } from '@/services/audit.service';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { projectId } = await params;
  const forbidden = await checkProjectPermission(user, projectId, 'idea:read');
  if (forbidden) return forbidden;

  const sp = new URL(req.url).searchParams;
  const kind = sp.get('kind');
  const validKind = kind && (IDEA_VOTING_KINDS as readonly string[]).includes(kind)
    ? (kind as IdeaVotingKind)
    : undefined;
  const statusRaw = sp.get('status') ?? undefined;
  const validStatus = statusRaw && (IDEA_SESSION_STATUSES as readonly string[]).includes(statusRaw)
    ? statusRaw
    : undefined;
  const q = sp.get('q') ?? undefined;

  const sessions = await listVotingSessions(projectId, user.id, user.tenantId, validKind, validStatus, q);
  return NextResponse.json({ data: sessions });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { projectId } = await params;
  const memberOnly = await requireActualProjectMember(user, projectId);
  if (memberOnly) return memberOnly;
  const forbidden = await checkProjectPermission(user, projectId, 'idea:manage');
  if (forbidden) return forbidden;

  const body = await req.json();
  const parsed = createVotingSessionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', details: parsed.error.issues } },
      { status: 400 },
    );
  }

  let session;
  try {
    session = await createVotingSession(projectId, parsed.data, user.id, user.tenantId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === 'INVALID_ENDS_AT') {
      return NextResponse.json(
        { error: { code: 'INVALID_ENDS_AT', message: '終了日時は未来の日時を指定してください' } },
        { status: 400 },
      );
    }
    throw e;
  }

  await recordAuditLog({
    tenantId: user.tenantId,
    userId: user.id,
    action: 'CREATE',
    entityType: 'idea_voting_session',
    entityId: session.id,
    afterValue: { title: session.title, kind: session.kind, voteType: session.voteType },
  });

  return NextResponse.json({ data: session }, { status: 201 });
}
