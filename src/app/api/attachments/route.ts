/**
 * GET  /api/attachments?entityType=...&entityId=... - 添付一覧取得
 * POST /api/attachments - 添付追加 (URL 参照型)
 *
 * 役割:
 *   ポリモーフィック添付テーブル (attachments) の汎用 CRUD。
 *   entity_type + entity_id で 6 種のエンティティ (project / task / estimate /
 *   risk / retrospective / knowledge / memo) と紐付き、URL のみ保持する設計
 *   (実ファイルは外部ストレージ)。
 *
 * 認可:
 *   - memo entity の場合: authorizeMemoAttachment (作成者本人 or public 限定)
 *   - その他の entity: checkMembership (該当プロジェクトのメンバー / admin)
 *
 * 関連:
 *   - DESIGN.md §22 (添付リンク設計 - ポリモーフィック関連)
 *   - PR #64 / #70
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { checkMembership } from '@/lib/permissions';
import { createAttachmentSchema, ATTACHMENT_ENTITY_TYPES } from '@/lib/validators/attachment';
import type { AttachmentEntityType } from '@/lib/validators/attachment';
import {
  authorizeMemoAttachment,
  createAttachment,
  listAttachments,
  resolveProjectIds,
} from '@/services/attachment.service';
import { recordAuditLog } from '@/services/audit.service';

/**
 * 親エンティティ → プロジェクト群を解決したうえで、
 * 指定されたアクセス種別 (read/write) の権限を判定する共通認可ユーティリティ。
 *
 * 認可ルール (Phase 1):
 *   - admin: 常に許可
 *   - メンバー (projectMember にレコード有): read/write 両方許可
 *   - 非メンバー: 拒否
 *   - 孤児ナレッジ (紐付けプロジェクト 0 件): admin のみ許可
 *
 * 将来的に「read は projectMember 不要 (公開ナレッジは誰でも見られる)」のような
 * 緩和が必要になった場合は、mode に応じた条件分岐をここに追加する。
 */
async function authorize(
  user: { id: string; systemRole: string },
  entityType: AttachmentEntityType,
  entityId: string,
  mode: 'read' | 'write' = 'write',
): Promise<NextResponse | null> {
  // PR #70: memo は admin 特権なしの個人リソース。project スコープとは別経路で判定する。
  if (entityType === 'memo') {
    const { ok, notFound } = await authorizeMemoAttachment(entityId, user.id, mode);
    if (notFound) {
      return NextResponse.json(
        { error: { code: 'NOT_FOUND', message: '対象が見つかりません' } },
        { status: 404 },
      );
    }
    if (!ok) {
      return NextResponse.json(
        { error: { code: 'FORBIDDEN', message: 'この操作を実行する権限がありません' } },
        { status: 403 },
      );
    }
    return null;
  }

  if (user.systemRole === 'admin') return null;

  const projectIds = await resolveProjectIds(entityType, entityId);
  if (projectIds === null) {
    return NextResponse.json(
      { error: { code: 'NOT_FOUND', message: '対象が見つかりません' } },
      { status: 404 },
    );
  }
  if (projectIds.length === 0) {
    // 孤児ナレッジ等は admin 以外不可
    return NextResponse.json(
      { error: { code: 'FORBIDDEN', message: 'この操作を実行する権限がありません' } },
      { status: 403 },
    );
  }

  // いずれか 1 つでもメンバーなら許可 (ナレッジは複数プロジェクト紐付け有り)
  for (const pid of projectIds) {
    const membership = await checkMembership(pid, user.id, user.systemRole);
    if (membership.isMember) return null;
  }
  return NextResponse.json(
    { error: { code: 'FORBIDDEN', message: 'この操作を実行する権限がありません' } },
    { status: 403 },
  );
}

/**
 * GET /api/attachments?entityType=risk&entityId=...&slot=primary
 * 指定エンティティに紐づく添付一覧を返す。slot は任意 (絞り込み用)。
 */
export async function GET(req: NextRequest) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const url = new URL(req.url);
  const entityType = url.searchParams.get('entityType');
  const entityId = url.searchParams.get('entityId');
  const slot = url.searchParams.get('slot') ?? undefined;

  if (!entityType || !entityId) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', message: 'entityType と entityId は必須です' } },
      { status: 400 },
    );
  }
  if (!ATTACHMENT_ENTITY_TYPES.includes(entityType as AttachmentEntityType)) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', message: 'entityType が不正です' } },
      { status: 400 },
    );
  }

  const typed = entityType as AttachmentEntityType;
  const forbidden = await authorize(user, typed, entityId, 'read');
  if (forbidden) return forbidden;

  const data = await listAttachments(typed, entityId, slot);
  return NextResponse.json({ data });
}

/**
 * POST /api/attachments
 * 新規添付リンクを作成する (単数スロットは既存行を論理削除して置換)。
 */
export async function POST(req: NextRequest) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const body = await req.json();
  const parsed = createAttachmentSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', details: parsed.error.issues } },
      { status: 400 },
    );
  }

  const forbidden = await authorize(user, parsed.data.entityType, parsed.data.entityId, 'write');
  if (forbidden) return forbidden;

  const created = await createAttachment(parsed.data, user.id);

  await recordAuditLog({
    userId: user.id,
    action: 'CREATE',
    entityType: 'attachment',
    entityId: created.id,
  });

  return NextResponse.json({ data: created }, { status: 201 });
}
