import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { createKnowledgeSchema } from '@/lib/validators/knowledge';
import { listKnowledge, createKnowledge } from '@/services/knowledge.service';
import { recordAuditLog, sanitizeForAudit } from '@/services/audit.service';

export async function GET(req: NextRequest) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { searchParams } = req.nextUrl;
  const result = await listKnowledge(
    {
      keyword: searchParams.get('keyword') || undefined,
      knowledgeType: searchParams.get('knowledgeType') || undefined,
      visibility: searchParams.get('visibility') || undefined,
      page: Number(searchParams.get('page')) || 1,
      limit: Number(searchParams.get('limit')) || 20,
    },
    user.id,
    user.systemRole,
  );

  return NextResponse.json({
    data: result.data,
    meta: {
      total: result.total,
      page: Number(searchParams.get('page')) || 1,
      limit: Number(searchParams.get('limit')) || 20,
    },
  });
}

export async function POST(req: NextRequest) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  // admin, pm_tl, member が作成可（viewer は不可）
  // ここではログイン済みなら作成可（権限チェックはプロジェクトスコープで行うのがメイン）

  const body = await req.json();
  const parsed = createKnowledgeSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', details: parsed.error.issues } },
      { status: 400 },
    );
  }

  const knowledge = await createKnowledge(parsed.data, user.id);

  await recordAuditLog({
    userId: user.id,
    action: 'CREATE',
    entityType: 'knowledge',
    entityId: knowledge.id,
    afterValue: sanitizeForAudit(knowledge as unknown as Record<string, unknown>),
  });

  return NextResponse.json({ data: knowledge }, { status: 201 });
}
