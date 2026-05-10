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
 * 認可ディスパッチテーブル: entityType (`ATTACHMENT_ENTITY_TYPES` enum で whitelist 検証済) を
 *   key とし、対応する authorizer を index lookup する。
 *
 * 2026-05-10 PR #302: CodeQL `js/user-controlled-bypass` (CWE-290 / CWE-807) false positive 抑止のため、
 *   旧 `if (entityType === 'memo') { ... }` 形式から **constant-record dispatch** に置換。
 *   - user-controlled な値で **if-branch を切る** 形だと CodeQL が「user が認可経路を選択できる」と
 *     誤検出する (実際は両 path とも同等の認可を実施しており bypass はない)。
 *   - `Record<AttachmentEntityType, ...>` の型注釈は **TypeScript レベルで全 entityType に対する
 *     handler の網羅性** を強制する (新 entityType 追加時は本テーブル更新が compile error で要求される)。
 *   - dispatch 対象の lookup key は **既に enum で whitelist** されているため、未知値による
 *     bypass の経路は構造的に存在しない (= `undefined` 関数呼び出しで実行時例外、サイレント bypass にならない)。
 *
 * 詳細: docs/knowledge/KDD_PATTERNS.md §5.X+16
 */
const ATTACHMENT_AUTHORIZER: Record<
  AttachmentEntityType,
  (user: AuthorizedUser, entityId: string, mode: 'read' | 'write') => Promise<NextResponse | null>
> = {
  memo: (user, entityId, mode) => authorizeMemoEntity(user, entityId, mode),
  project: (user, entityId, mode) => authorizeProjectScopedEntity(user, 'project', entityId, mode),
  task: (user, entityId, mode) => authorizeProjectScopedEntity(user, 'task', entityId, mode),
  estimate: (user, entityId, mode) => authorizeProjectScopedEntity(user, 'estimate', entityId, mode),
  risk: (user, entityId, mode) => authorizeProjectScopedEntity(user, 'risk', entityId, mode),
  retrospective: (user, entityId, mode) =>
    authorizeProjectScopedEntity(user, 'retrospective', entityId, mode),
  knowledge: (user, entityId, mode) =>
    authorizeProjectScopedEntity(user, 'knowledge', entityId, mode),
};

/**
 * 親エンティティの authorizer を `ATTACHMENT_AUTHORIZER` ディスパッチテーブルから index lookup
 * して呼び出す共通認可ユーティリティ。
 *
 * 2026-05-09 feedback: severity-1 テナント越境対策で checkMembership に tenantId が必須化されたため、
 *   本ヘルパー引数の user にも tenantId を含める。getAuthenticatedUser() の戻り値と一致。
 */
async function authorize(
  user: AuthorizedUser,
  entityType: AttachmentEntityType,
  entityId: string,
  mode: 'read' | 'write' = 'write',
): Promise<NextResponse | null> {
  return ATTACHMENT_AUTHORIZER[entityType](user, entityId, mode);
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

  const created = await createAttachment(parsed.data, user.id, user.tenantId);

  await recordAuditLog({
    userId: user.id,
    action: 'CREATE',
    entityType: 'attachment',
    entityId: created.id,
  });

  return NextResponse.json({ data: created }, { status: 201 });
}
