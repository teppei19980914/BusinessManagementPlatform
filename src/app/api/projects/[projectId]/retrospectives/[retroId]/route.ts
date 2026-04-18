import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser, checkProjectPermission } from '@/lib/api-helpers';
import {
  deleteRetrospective,
  getRetrospective,
  updateRetrospective,
} from '@/services/retrospective.service';
import { recordAuditLog, sanitizeForAudit } from '@/services/audit.service';

/**
 * 振り返り更新 (PR #56 Req 8/9)。
 * 認可: ProjectMember (admin は全プロジェクトでメンバー相当)。
 * 編集可能フィールドは updateRetrospective の input 型を参照。
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string; retroId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { projectId, retroId } = await params;

  const existing = await getRetrospective(retroId);
  if (!existing || existing.projectId !== projectId) {
    return NextResponse.json(
      { error: { code: 'NOT_FOUND', message: '対象が見つかりません' } },
      { status: 404 },
    );
  }

  // 振り返り編集は project メンバー全員に許可 (project:update 権限を流用)
  const forbidden = await checkProjectPermission(user, projectId, 'project:update');
  if (forbidden) return forbidden;

  const body = await req.json();
  // zod バリデーションは作成時 schema の部分適用。MVP では型チェックのみで
  // フィールドのホワイトリストを service 側に委任する。
  await updateRetrospective(retroId, body, user.id);

  await recordAuditLog({
    userId: user.id,
    action: 'UPDATE',
    entityType: 'retrospective',
    entityId: retroId,
    beforeValue: sanitizeForAudit(existing as unknown as Record<string, unknown>),
    afterValue: sanitizeForAudit(body as Record<string, unknown>),
  });

  return NextResponse.json({ data: { success: true } });
}

/**
 * 振り返り削除エンドポイント (2026-04-18 追加)。
 *
 * 認可:
 *   - project:delete 権限を持つロール (admin / pm_tl) のみ削除可
 *   - admin は checkMembership で全プロジェクトへのアクセス権を持つため
 *     「全振り返り」画面からでも削除可能
 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ projectId: string; retroId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { projectId, retroId } = await params;

  const existing = await getRetrospective(retroId);
  if (!existing || existing.projectId !== projectId) {
    return NextResponse.json(
      { error: { code: 'NOT_FOUND', message: '対象が見つかりません' } },
      { status: 404 },
    );
  }

  // 振り返りの削除は project:delete 相当 (レビュー結果を破棄する操作のため pm_tl 以上)
  const forbidden = await checkProjectPermission(user, projectId, 'project:delete');
  if (forbidden) return forbidden;

  await deleteRetrospective(retroId, user.id);
  await recordAuditLog({
    userId: user.id,
    action: 'DELETE',
    entityType: 'retrospective',
    entityId: retroId,
    beforeValue: sanitizeForAudit(existing as unknown as Record<string, unknown>),
  });
  return NextResponse.json({ data: { success: true } });
}
