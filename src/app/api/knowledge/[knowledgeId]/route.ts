/**
 * GET    /api/knowledge/[knowledgeId] - 単一ナレッジ取得
 * PATCH  /api/knowledge/[knowledgeId] - ナレッジ編集
 * DELETE /api/knowledge/[knowledgeId] - ナレッジ論理削除
 *
 * 認可 (2026-04-24 改修):
 *   GET: public はログイン済全員。draft は作成者本人 + admin のみ。
 *   PATCH: **作成者本人のみ** (admin でも他人のは不可)。サービス層で enforce。
 *   DELETE: 作成者本人 OR admin (全ナレッジ画面からの管理削除)。サービス層で enforce。
 *
 * 監査: PATCH/DELETE 時に audit_logs に before/after を記録。
 *
 * 関連: DESIGN.md §5 / §8.3 (権限制御)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from 'next-intl/server';
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
  const t = await getTranslations('message');
  // 2026-04-24: service 層で public/draft 判定 (他人の draft は null)
  const knowledge = await getKnowledge(knowledgeId, user.id, user.systemRole);

  if (!knowledge) {
    return NextResponse.json(
      { error: { code: 'NOT_FOUND', message: t('notFoundTarget') } },
      { status: 404 },
    );
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
  const t = await getTranslations('message');
  // 内部呼び出し (認可オフ) で生行を取得してから service 層で判定させる
  const existing = await getKnowledge(knowledgeId);

  if (!existing) {
    return NextResponse.json(
      { error: { code: 'NOT_FOUND', message: t('notFoundTarget') } },
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
    knowledge = await updateKnowledge(knowledgeId, parsed.data, user.id, user.tenantId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === 'FORBIDDEN') {
      return NextResponse.json(
        { error: { code: 'FORBIDDEN', message: t('creatorOnlyEdit') } },
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
  { params }: { params: Promise<{ knowledgeId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { knowledgeId } = await params;
  const t = await getTranslations('message');
  const existing = await getKnowledge(knowledgeId);

  if (!existing) {
    return NextResponse.json(
      { error: { code: 'NOT_FOUND', message: t('notFoundTarget') } },
      { status: 404 },
    );
  }

  // 2026-04-24: 削除は作成者本人 OR admin (service 層で enforce)。
  try {
    await deleteKnowledge(knowledgeId, user.id, user.systemRole);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === 'FORBIDDEN') {
      return NextResponse.json(
        { error: { code: 'FORBIDDEN', message: t('creatorOrAdminOnlyDelete') } },
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
