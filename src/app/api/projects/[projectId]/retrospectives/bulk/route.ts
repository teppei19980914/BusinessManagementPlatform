import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from 'next-intl/server';
import { getAuthenticatedUser, checkProjectPermission } from '@/lib/api-helpers';
import { bulkUpdateRetrospectivesVisibilityFromList } from '@/services/retrospective.service';
import {
  bulkUpdateRetrospectiveVisibilitySchema,
  isCrossListFilterApplied,
} from '@/lib/validators/cross-list-bulk-visibility';

/**
 * プロジェクト「振り返り一覧」からの一括 visibility 更新エンドポイント (PR #165 で
 * cross-list `/api/retrospectives/bulk` から project-scoped に移し替え、元実装は PR #162)。
 *
 * 認可:
 *   - **`retrospective:update` 権限が必要** (= プロジェクトメンバーかつ管理者/PM/TL/メンバー)。
 *   - per-row 作成者一致判定はサービス層で実施 (admin であっても他人の振り返りは更新不可)。
 *
 * 安全策: filterFingerprint が空なら 400 FILTER_REQUIRED で拒否、ids 上限 500、
 * projectId scope で他プロジェクトの行はサービス層で skippedNotFound 扱い。
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { projectId } = await params;

  // Retrospective は専用の retrospective:update Action が無く、project:update を流用 (PATCH/POST 既存方針と同じ)
  const forbidden = await checkProjectPermission(user, projectId, 'project:update');
  if (forbidden) return forbidden;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const parsed = bulkUpdateRetrospectiveVisibilitySchema.safeParse(body);
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

  const result = await bulkUpdateRetrospectivesVisibilityFromList(
    projectId,
    parsed.data.ids,
    parsed.data.visibility,
    user.id,
  );

  return NextResponse.json({ data: result });
}
