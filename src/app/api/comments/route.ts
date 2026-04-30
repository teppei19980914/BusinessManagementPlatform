/**
 * GET  /api/comments?entityType=...&entityId=... - コメント一覧取得
 * POST /api/comments                              - コメント新規投稿
 *
 * 役割:
 *   ポリモーフィック comments テーブルの汎用 CRUD (PR #199)。
 *   entity_type + entity_id で 7 種のエンティティ
 *   (issue / task / risk / retrospective / knowledge / customer / stakeholder) と紐づく。
 *
 * 認可ポリシー:
 *   - issue / risk / retrospective / knowledge: **認証済ユーザは誰でも 投稿/閲覧 可**
 *     (要件 Q4: 「全○○」では非 ProjectMember もコメント受付)
 *   - task / stakeholder: project member or admin (top-level 画面なし)
 *   - customer: admin only (/customers が admin 専用画面)
 *
 * Rate-limit:
 *   PR #198 と同様の保護を入れる必要は低い (認証必須エンドポイントのため)。
 *   本 PR では未適用、回数制限が必要になった時点で `applyRateLimit` を追加する。
 *
 * 関連:
 *   - DESIGN.md コメント機能節 (PR #199 で追記)
 *   - DEVELOPER_GUIDE §5.49 (本機能の実装ナレッジ)
 *   - src/services/comment.service.ts
 */

import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from 'next-intl/server';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { checkMembership } from '@/lib/permissions';
import {
  createCommentSchema,
  COMMENT_ENTITY_TYPES,
} from '@/lib/validators/comment';
import type { CommentEntityType } from '@/lib/validators/comment';
import {
  createComment,
  listComments,
  resolveEntityForComment,
} from '@/services/comment.service';
import { recordAuditLog } from '@/services/audit.service';

/**
 * 親エンティティの存在確認 + 認可。リクエストユーザが当該 entity に対して
 * **コメントの読み書きを行う権利** を持つかを判定する。
 *
 * 戻り値: NextResponse (拒否時) or null (許可)。
 */
async function authorizeForComment(
  user: { id: string; systemRole: string },
  entityType: CommentEntityType,
  entityId: string,
): Promise<NextResponse | null> {
  const t = await getTranslations('message');
  const result = await resolveEntityForComment(entityType, entityId);

  if (result.kind === 'not-found') {
    return NextResponse.json(
      { error: { code: 'NOT_FOUND', message: t('notFoundTarget') } },
      { status: 404 },
    );
  }

  // admin は常に許可 (孤児データ管理 / customer / 全エンティティ救済)
  if (user.systemRole === 'admin') return null;

  if (result.kind === 'admin-only') {
    // customer: admin 以外拒否
    return NextResponse.json(
      { error: { code: 'FORBIDDEN', message: t('forbidden') } },
      { status: 403 },
    );
  }

  if (result.kind === 'open') {
    // 全○○ ありエンティティ (issue/risk/retrospective/knowledge): 認証済ユーザは誰でも可 (要件 Q4)
    return null;
  }

  // project-scoped (task/stakeholder): project member 必須
  for (const pid of result.projectIds) {
    const m = await checkMembership(pid, user.id, user.systemRole);
    if (m.isMember) return null;
  }
  return NextResponse.json(
    { error: { code: 'FORBIDDEN', message: t('forbidden') } },
    { status: 403 },
  );
}

/**
 * GET /api/comments?entityType=issue&entityId=...
 * 指定エンティティに紐づくコメントを新しい順 (createdAt DESC) で返す。
 */
export async function GET(req: NextRequest) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const url = new URL(req.url);
  const entityType = url.searchParams.get('entityType');
  const entityId = url.searchParams.get('entityId');

  const t = await getTranslations('message');
  if (!entityType || !entityId) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', message: t('invalidRequest') } },
      { status: 400 },
    );
  }
  if (!COMMENT_ENTITY_TYPES.includes(entityType as CommentEntityType)) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', message: t('invalidRequest') } },
      { status: 400 },
    );
  }

  const typed = entityType as CommentEntityType;
  const forbidden = await authorizeForComment(user, typed, entityId);
  if (forbidden) return forbidden;

  const data = await listComments(typed, entityId);
  return NextResponse.json({ data });
}

/**
 * POST /api/comments
 * 認証済ユーザがコメントを投稿する。entity 認可は authorizeForComment で実施。
 */
export async function POST(req: NextRequest) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const body = await req.json();
  const parsed = createCommentSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', details: parsed.error.issues } },
      { status: 400 },
    );
  }

  const forbidden = await authorizeForComment(
    user,
    parsed.data.entityType,
    parsed.data.entityId,
  );
  if (forbidden) return forbidden;

  const created = await createComment(parsed.data, user.id);

  await recordAuditLog({
    userId: user.id,
    action: 'CREATE',
    entityType: 'comment',
    entityId: created.id,
  });

  return NextResponse.json({ data: created }, { status: 201 });
}
