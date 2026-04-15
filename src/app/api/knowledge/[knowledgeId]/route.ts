import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { updateKnowledgeSchema } from '@/lib/validators/knowledge';
import { getKnowledge, updateKnowledge, deleteKnowledge } from '@/services/knowledge.service';
import { recordAuditLog, sanitizeForAudit } from '@/services/audit.service';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ knowledgeId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { knowledgeId } = await params;
  const knowledge = await getKnowledge(knowledgeId);

  if (!knowledge) {
    return NextResponse.json(
      { error: { code: 'NOT_FOUND', message: '対象が見つかりません' } },
      { status: 404 },
    );
  }

  // 公開範囲チェック
  if (user.systemRole !== 'admin') {
    if (knowledge.visibility === 'draft' && knowledge.createdBy !== user.id) {
      return NextResponse.json(
        { error: { code: 'FORBIDDEN', message: 'この操作を実行する権限がありません' } },
        { status: 403 },
      );
    }
  }

  return NextResponse.json({ data: knowledge });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ knowledgeId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { knowledgeId } = await params;
  const existing = await getKnowledge(knowledgeId);

  if (!existing) {
    return NextResponse.json(
      { error: { code: 'NOT_FOUND', message: '対象が見つかりません' } },
      { status: 404 },
    );
  }

  // 編集権限: admin は全て、pm_tl は全て、member は自分の下書きのみ
  if (user.systemRole !== 'admin') {
    if (existing.createdBy !== user.id) {
      return NextResponse.json(
        { error: { code: 'FORBIDDEN', message: '自分が作成したナレッジのみ編集できます' } },
        { status: 403 },
      );
    }
  }

  const body = await req.json();
  const parsed = updateKnowledgeSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', details: parsed.error.issues } },
      { status: 400 },
    );
  }

  const knowledge = await updateKnowledge(knowledgeId, parsed.data, user.id);

  await recordAuditLog({
    userId: user.id,
    action: 'UPDATE',
    entityType: 'knowledge',
    entityId: knowledgeId,
    beforeValue: sanitizeForAudit(existing as unknown as Record<string, unknown>),
    afterValue: sanitizeForAudit(knowledge as unknown as Record<string, unknown>),
  });

  return NextResponse.json({ data: knowledge });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ knowledgeId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  // 削除は admin, pm_tl のみ
  if (user.systemRole !== 'admin') {
    return NextResponse.json(
      { error: { code: 'FORBIDDEN', message: 'この操作を実行する権限がありません' } },
      { status: 403 },
    );
  }

  const { knowledgeId } = await params;
  const existing = await getKnowledge(knowledgeId);

  if (!existing) {
    return NextResponse.json(
      { error: { code: 'NOT_FOUND', message: '対象が見つかりません' } },
      { status: 404 },
    );
  }

  await deleteKnowledge(knowledgeId, user.id);

  await recordAuditLog({
    userId: user.id,
    action: 'DELETE',
    entityType: 'knowledge',
    entityId: knowledgeId,
    beforeValue: sanitizeForAudit(existing as unknown as Record<string, unknown>),
  });

  return NextResponse.json({ data: { success: true } });
}
