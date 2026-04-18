import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser, checkProjectPermission } from '@/lib/api-helpers';
import { updateKnowledgeSchema } from '@/lib/validators/knowledge';
import { getKnowledge, updateKnowledge, deleteKnowledge } from '@/services/knowledge.service';
import { recordAuditLog, sanitizeForAudit } from '@/services/audit.service';

/**
 * プロジェクト scoped ナレッジ更新/削除エンドポイント。
 *
 * 設計 (2026-04-18):
 *   Phase B で合意した認可方針「紐づくプロジェクトの ProjectMember のみ更新/削除可能」
 *   を実現するための経路。既存の /api/knowledge/[knowledgeId] は admin または作成者
 *   に限定される制約があり、プロジェクトメンバー (作成者以外) からの編集/削除を
 *   受け入れられなかった。
 *
 *   本ルートでは「このプロジェクトに紐づくナレッジであること」を確認した上で
 *   checkProjectPermission で ProjectMember を判定するため、メンバーなら編集/削除できる。
 *
 *   変更内容自体は共通の updateKnowledge / deleteKnowledge を呼ぶので、
 *   「ナレッジ一覧」で更新したら「全ナレッジ」にも即座に反映される (連動)。
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string; knowledgeId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { projectId, knowledgeId } = await params;
  const forbidden = await checkProjectPermission(user, projectId, 'knowledge:update');
  if (forbidden) return forbidden;

  const existing = await getKnowledge(knowledgeId);
  if (!existing) {
    return NextResponse.json(
      { error: { code: 'NOT_FOUND', message: '対象が見つかりません' } },
      { status: 404 },
    );
  }
  // この projectId に紐づくナレッジのみ対象
  if (!existing.projectIds?.includes(projectId)) {
    return NextResponse.json(
      { error: { code: 'NOT_FOUND', message: 'このプロジェクトに紐づくナレッジではありません' } },
      { status: 404 },
    );
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
  { params }: { params: Promise<{ projectId: string; knowledgeId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { projectId, knowledgeId } = await params;
  const forbidden = await checkProjectPermission(user, projectId, 'knowledge:delete');
  if (forbidden) return forbidden;

  const existing = await getKnowledge(knowledgeId);
  if (!existing) {
    return NextResponse.json(
      { error: { code: 'NOT_FOUND', message: '対象が見つかりません' } },
      { status: 404 },
    );
  }
  if (!existing.projectIds?.includes(projectId)) {
    return NextResponse.json(
      { error: { code: 'NOT_FOUND', message: 'このプロジェクトに紐づくナレッジではありません' } },
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
