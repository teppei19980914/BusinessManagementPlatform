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

  let knowledge;
  try {
    // 2026-04-24: 作成者本人のみ編集可 (admin でも他人は不可)。service 層で enforce。
    knowledge = await updateKnowledge(knowledgeId, parsed.data, user.id);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === 'FORBIDDEN') {
      return NextResponse.json(
        { error: { code: 'FORBIDDEN', message: '作成者本人のみ編集できます' } },
        { status: 403 },
      );
    }
    if (msg === 'NOT_FOUND') {
      return NextResponse.json({ error: { code: 'NOT_FOUND' } }, { status: 404 });
    }
    throw e;
  }

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

  try {
    // 2026-04-24: 削除は作成者本人 OR admin (service 層で enforce)。
    await deleteKnowledge(knowledgeId, user.id, user.systemRole);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === 'FORBIDDEN') {
      return NextResponse.json(
        { error: { code: 'FORBIDDEN', message: '作成者本人または管理者のみ削除できます' } },
        { status: 403 },
      );
    }
    if (msg === 'NOT_FOUND') {
      return NextResponse.json({ error: { code: 'NOT_FOUND' } }, { status: 404 });
    }
    throw e;
  }

  await recordAuditLog({
    userId: user.id,
    action: 'DELETE',
    entityType: 'knowledge',
    entityId: knowledgeId,
    beforeValue: sanitizeForAudit(existing as unknown as Record<string, unknown>),
  });

  return NextResponse.json({ data: { success: true } });
}
