import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from 'next-intl/server';
import { getAuthenticatedUser, checkProjectPermission } from '@/lib/api-helpers';
import { bulkUpdateKnowledgeVisibilityFromList } from '@/services/knowledge.service';
import {
  bulkUpdateKnowledgeVisibilitySchema,
  isCrossListFilterApplied,
} from '@/lib/validators/cross-list-bulk-visibility';

/**
 * プロジェクト「ナレッジ一覧」からの一括 visibility 更新エンドポイント (PR #165 で
 * cross-list `/api/knowledge/bulk` から project-scoped に移し替え、元実装は PR #162)。
 *
 * 認可:
 *   - **`knowledge:update` 権限が必要** (= プロジェクトメンバーかつ管理者/PM/TL/メンバー)。
 *   - per-row 作成者一致判定はサービス層で実施 (admin であっても他人のナレッジは更新不可)。
 *   - Knowledge は多対多なのでサービス層 where に `knowledgeProjects: { some: { projectId } }`
 *     を加え、当該プロジェクトに紐付くナレッジのみを対象にする。
 *
 * 安全策: filterFingerprint が空なら 400 FILTER_REQUIRED で拒否、ids 上限 500。
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { projectId } = await params;

  const forbidden = await checkProjectPermission(user, projectId, 'knowledge:update');
  if (forbidden) return forbidden;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const parsed = bulkUpdateKnowledgeVisibilitySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'VALIDATION_ERROR', details: parsed.error.format() },
      { status: 400 },
    );
  }

  if (!isCrossListFilterApplied(parsed.data.filterFingerprint)) {
    const t = await getTranslations('message');
    return NextResponse.json(
      { error: 'FILTER_REQUIRED', message: t('filterRequiredForBulk') },
      { status: 400 },
    );
  }

  const result = await bulkUpdateKnowledgeVisibilityFromList(
    projectId,
    parsed.data.ids,
    parsed.data.visibility,
    user.id,
  );

  return NextResponse.json({ data: result });
}
