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
import { getAuthenticatedUser, requireStorageQuotaForWrite } from '@/lib/api-helpers';
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

type AuthorizedUser = { id: string; systemRole: string; tenantId: string };

/**
 * memo entity 用の認可パス。
 * memo は admin 特権なしの個人リソース (PR #70)。project スコープとは別経路で判定する。
 */
async function authorizeMemoEntity(
  user: AuthorizedUser,
  entityId: string,
  mode: 'read' | 'write',
): Promise<NextResponse | null> {
  const t = await getTranslations('message');
  const { ok, notFound } = await authorizeMemoAttachment(entityId, user.id, mode, user.tenantId);
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

/**
 * project スコープ entity (project/task/estimate/risk/retrospective/knowledge) 用の認可パス。
 *
 * 認可ルール:
 *   - admin: 常に許可
 *   - **read on visibility='public' entity (risk/retrospective/knowledge)**: 認証済全員可
 *     (PR #213 / 2026-05-01: 「全○○」の readOnly dialog から非メンバーが添付一覧を取得する経路を救済)
 *   - read on visibility='draft' entity: 作成者本人 OR admin
 *   - write: project member 必須 (visibility に関わらず)
 *   - 孤児ナレッジ (紐付けプロジェクト 0 件): admin のみ操作可
 */
async function authorizeProjectScopedEntity(
  user: AuthorizedUser,
  entityType: AttachmentEntityType,
  entityId: string,
  mode: 'read' | 'write',
): Promise<NextResponse | null> {
  const t = await getTranslations('message');

  if (user.systemRole === 'admin') return null;

  // PR #213 / 2026-05-01: visibility-aware read 認可。
  //   public な risk/retrospective/knowledge の添付は cross-list 画面で非メンバーが
  //   見るのが正常動線 (read-only dialog から AttachmentList が GET する)。
  //   write 時は引き続き project member 必須 (visibility 関係なく)。
  if (mode === 'read') {
    const visInfo = await getEntityVisibility(entityType, entityId, user.tenantId);
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
  const projectIds = await resolveProjectIds(entityType, entityId, user.tenantId);
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
    const membership = await checkMembership(pid, user.id, user.systemRole, user.tenantId);
    if (membership.isMember) return null;
  }
  return NextResponse.json(
    { error: { code: 'FORBIDDEN', message: t('forbidden') } },
    { status: 403 },
  );
}

/**
 * 親エンティティの authorizer を **静的な switch 文** で dispatch する共通認可ユーティリティ。
 *
 * 2026-05-09 feedback: severity-1 テナント越境対策で checkMembership に tenantId が必須化されたため、
 *   本ヘルパー引数の user にも tenantId を含める。getAuthenticatedUser() の戻り値と一致。
 *
 * 2026-05-10 PR #302 (commit #2): CodeQL false positive 対応の試行錯誤を経て **switch 文** に確定:
 *   - 試行 1 (元コード): `if (entityType === 'memo') { ... } else { ... }` →
 *     `js/user-controlled-bypass` (CWE-290/807) で flagged (user-controlled value が
 *     security check を gate していると判定された)。
 *   - 試行 2 (constant-record dispatch): `ATTACHMENT_AUTHORIZER[entityType](...)` →
 *     `js/unvalidated-dynamic-method-call` (CWE-94) で flagged (user-controlled name で
 *     dynamic method call → 未知 key で `undefined()` 例外の懸念)。
 *   - 試行 3 (本実装、switch 文): 各 case label が **静的 string literal** で、dispatch は
 *     **コンパイル時に確定** する。CodeQL は exhaustive switch on typed enum を
 *     "user-controlled bypass" としても "dynamic method call" としても扱わない。
 *     さらに TypeScript exhaustiveness check (`exhaustive: never`) で全 enum 値の
 *     case 漏れを compile-time に検出する。
 *
 * 詳細: docs/knowledge/KDD_PATTERNS.md §5.X+16
 */
async function authorize(
  user: AuthorizedUser,
  entityType: AttachmentEntityType,
  entityId: string,
  mode: 'read' | 'write' = 'write',
): Promise<NextResponse | null> {
  switch (entityType) {
    case 'memo':
      return authorizeMemoEntity(user, entityId, mode);
    case 'project':
    case 'task':
    case 'estimate':
    case 'risk':
    case 'retrospective':
    case 'knowledge':
      return authorizeProjectScopedEntity(user, entityType, entityId, mode);
    default: {
      // TypeScript exhaustiveness check: 新 entityType 追加時は本 default 節で
      // compile error になるため、authorize() の case 漏れを構造的に防ぐ。
      const _exhaustive: never = entityType;
      throw new Error(`Unhandled attachment entityType: ${String(_exhaustive)}`);
    }
  }
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

  const data = await listAttachments(typed, entityId, user.tenantId, slot);
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

  // PR-5 (2026-05-15): ストレージ容量 Pre-check
  const quotaErr = await requireStorageQuotaForWrite(
    user.tenantId,
    JSON.stringify(parsed.data).length,
  );
  if (quotaErr) return quotaErr;

  const created = await createAttachment(parsed.data, user.id, user.tenantId);

  await recordAuditLog({
    tenantId: user.tenantId,
    userId: user.id,
    action: 'CREATE',
    entityType: 'attachment',
    entityId: created.id,
  });

  return NextResponse.json({ data: created }, { status: 201 });
}
