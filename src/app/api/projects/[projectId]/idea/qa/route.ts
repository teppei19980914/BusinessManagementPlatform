/**
 * GET  /api/projects/[projectId]/idea/qa  — Q&A スレッド一覧
 * POST /api/projects/[projectId]/idea/qa  — スレッド作成
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  getAuthenticatedUser,
  checkProjectPermission,
  requireActualProjectMember,
} from '@/lib/api-helpers';
import {
  createQaThreadSchema,
  QA_SORT_TYPES,
  QA_FILTER_TYPES,
  type QaSortType,
  type QaFilterType,
} from '@/lib/validators/idea-session';
import { listQaThreads, createQaThread } from '@/services/idea-qa.service';
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
  const sortRaw = sp.get('sort');
  const filterRaw = sp.get('filter');
  const sort = sortRaw && (QA_SORT_TYPES as readonly string[]).includes(sortRaw)
    ? (sortRaw as QaSortType)
    : 'createdAt';
  const filter = filterRaw && (QA_FILTER_TYPES as readonly string[]).includes(filterRaw)
    ? (filterRaw as QaFilterType)
    : 'all';
  const q = sp.get('q') ?? undefined;

  const threads = await listQaThreads(projectId, user.id, user.tenantId, sort, filter, q);
  return NextResponse.json({ data: threads });
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
  const forbidden = await checkProjectPermission(user, projectId, 'idea:submit');
  if (forbidden) return forbidden;

  const body = await req.json();
  const parsed = createQaThreadSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', details: parsed.error.issues } },
      { status: 400 },
    );
  }

  const thread = await createQaThread(projectId, parsed.data, user.id, user.tenantId);

  await recordAuditLog({
    tenantId: user.tenantId,
    userId: user.id,
    action: 'CREATE',
    entityType: 'idea_qa_thread',
    entityId: thread.id,
  });

  return NextResponse.json({ data: thread }, { status: 201 });
}
