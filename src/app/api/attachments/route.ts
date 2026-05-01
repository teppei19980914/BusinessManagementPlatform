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
import { getTranslations } from 'next-intl/server';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { checkMembership } from '@/lib/permissions';
import { createAttachmentSchema, ATTACHMENT_ENTITY_TYPES } from '@/lib/validators/attachment';
import type { AttachmentEntityType } from '@/lib/validators/attachment';
import {
  authorizeMemoAttachment,
  createAttachment,
  getEntityVisibility,
  listAttachments,
  resolveProjectIds,
} from '@/services/attachment.service';
import { recordAuditLog } from '@/services/audit.service';

/**
 * 親エンティティ → プロジェクト群を解決したうえで、
 * 指定されたアクセス種別 (read/write) の権限を判定する共通認可ユーティリティ。
 *
 * 認可ルール:
 *   - admin: 常に許可
 *   - **read on visibility='public' entity (risk/retrospective/knowledge)**: 認証済全員可
 *     (PR #213 / 2026-05-01: 「全○○」の readOnly dialog から非メンバーが添付一覧を取得する経路を救済。
 *      batch route の fix/cross-list-non-member-columns (2026-04-27) と整合。
 *      旧仕様は singular GET も project member 必須で、非メンバーは 403 を踏んでいた)
 *   - read on visibility='draft' entity: 作成者本人 OR admin (admin はトップで通過済)
 *   - write: project member 必須 (visibility に関わらず)
 *   - 非メンバー (write): 拒否
 *   - 孤児ナレッジ (紐付けプロジェクト 0 件): admin のみ操作可
 */
async function authorize(
  user: { id: string; systemRole: string },
  entityType: AttachmentEntityType,
  entityId: string,
  mode: 'read' | 'write' = 'write',
): Promise<NextResponse | null> {
  const t = await getTranslations('message');
  // PR #70: memo は admin 特権なしの個人リソース。project スコープとは別経路で判定する。
  if (entityType === 'memo') {
    const { ok, notFound } = await authorizeMemoAttachment(entityId, user.id, mode);
    if (notFound) {
      return NextResponse.json(
        { error: { code: 'NOT_FOUND', message: t('notFoundTarget') } },
        { status: 404 },
      );
    }
    if (!ok) {
      return NextResponse.json(
        { error: { code: 'FORBIDDEN', message: t('forbidden') } },
        { status: 403 },
      );
    }
    return null;
  }

  if (user.systemRole === 'admin') return null;

  // PR #213 / 2026-05-01: visibility-aware read 認可。
  //   public な risk/retrospective/knowledge の添付は cross-list 画面で非メンバーが
  //   見るのが正常動線 (read-only dialog から AttachmentList が GET する)。
  //   write 時は引き続き project member 必須 (visibility 関係なく)。
  if (mode === 'read') {
    const visInfo = await getEntityVisibility(entityType, entityId);
    if (visInfo === 'not-found') {
      return NextResponse.json(
        { error: { code: 'NOT_FOUND', message: t('notFoundTarget') } },
        { status: 404 },
      );
    }
    if (visInfo !== null) {
      // visibility を持つ entity (risk/retrospective/knowledge)
      if (visInfo.visibility === 'public') return null; // 認証済全員可
      // draft: 作成者本人のみ (admin は上で通過済)
      if (visInfo.creatorId === user.id) return null;
      return NextResponse.json(
        { error: { code: 'FORBIDDEN', message: t('forbidden') } },
        { status: 403 },
      );
    }
    // visibility 概念なし (project/task/estimate) は下の project member 経路へ fall-through
  }

  // project member 経路 (write 全般 + read on project/task/estimate)
  const projectIds = await resolveProjectIds(entityType, entityId);
  if (projectIds === null) {
    return NextResponse.json(
      { error: { code: 'NOT_FOUND', message: t('notFoundTarget') } },
      { status: 404 },
    );
  }
  if (projectIds.length === 0) {
    // 孤児ナレッジ等は admin 以外不可
    return NextResponse.json(
      { error: { code: 'FORBIDDEN', message: t('forbidden') } },
      { status: 403 },
    );
  }

  // いずれか 1 つでもメンバーなら許可 (ナレッジは複数プロジェクト紐付け有り)
  for (const pid of projectIds) {
    const membership = await checkMembership(pid, user.id, user.systemRole);
    if (membership.isMember) return null;
  }
  return NextResponse.json(
    { error: { code: 'FORBIDDEN', message: t('forbidden') } },
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

  const t = await getTranslations('message');
  if (!entityType || !entityId) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', message: t('attachmentEntityRequired') } },
      { status: 400 },
    );
  }
  if (!ATTACHMENT_ENTITY_TYPES.includes(entityType as AttachmentEntityType)) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', message: t('attachmentEntityInvalid') } },
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
