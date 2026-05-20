/**
 * GET    /api/knowledge/[knowledgeId] - 単一ナレッジ取得 (横断)
 * DELETE /api/knowledge/[knowledgeId] - ナレッジ論理削除 (全ナレッジ画面経由、admin only)
 *
 * 認可 (feat/crud-permission-redesign, 2026-05-20 改訂):
 *   - GET: public はログイン済全員。draft は作成者本人 + admin のみ。
 *   - DELETE: context='global' (admin only)。「全ナレッジ」画面からの管理削除のみ。
 *     ○○一覧経由の作成者本人削除は /api/projects/[id]/knowledge/[knowledgeId] DELETE を使う。
 *   - PATCH ハンドラは削除済み: 横断 UI から更新する経路は存在しないため、UI=API 一致原則に従い
 *     ハンドラごと削除。プロジェクト内編集は /api/projects/[id]/knowledge/[knowledgeId] PATCH を使う。
 *
 * 監査: DELETE 時に audit_logs に before を記録。
 *
 * 関連: DESIGN.md §5 / §8.3 (権限制御)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from 'next-intl/server';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { getKnowledge, deleteKnowledge } from '@/services/knowledge.service';
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
  const knowledge = await getKnowledge(knowledgeId, user.id, user.systemRole, user.tenantId);

  if (!knowledge) {
    return NextResponse.json(
      { error: { code: 'NOT_FOUND', message: t('notFoundTarget') } },
      { status: 404 },
    );
  }

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
  const existing = await getKnowledge(knowledgeId, undefined, undefined, user.tenantId);

  if (!existing) {
    return NextResponse.json(
      { error: { code: 'NOT_FOUND', message: t('notFoundTarget') } },
      { status: 404 },
    );
  }

  // feat/crud-permission-redesign (2026-05-20): 横断「全ナレッジ」画面経由は admin のみ削除可。
  //   作成者本人削除は /api/projects/[id]/knowledge/[knowledgeId] DELETE 経由で行う。
  try {
    await deleteKnowledge(knowledgeId, user.id, user.systemRole, user.tenantId, 'global');
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
    tenantId: user.tenantId,
    userId: user.id,
    action: 'DELETE',
    entityType: 'knowledge',
    entityId: knowledgeId,
    beforeValue: sanitizeForAudit(existing as unknown as Record<string, unknown>),
  });

  return NextResponse.json({ data: { success: true } });
}
