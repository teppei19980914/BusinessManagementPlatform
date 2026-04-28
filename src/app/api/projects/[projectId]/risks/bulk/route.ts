import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from 'next-intl/server';
import { getAuthenticatedUser, checkProjectPermission } from '@/lib/api-helpers';
import { bulkUpdateRisksFromList } from '@/services/risk.service';
import { bulkUpdateRisksSchema, isFilterApplied } from '@/lib/validators/risk-bulk';

/**
 * プロジェクト「リスク/課題一覧」からの一括更新エンドポイント (PR #165 で
 * cross-list `/api/risks/bulk` から project-scoped に移し替え。元実装は PR #161)。
 *
 * 認可:
 *   - **`risk:update` 権限が必要** (= プロジェクトメンバーかつ管理者/PM/TL/メンバー)。
 *     `checkProjectPermission` で resourceOwnerId なし呼び出しによりロール判定のみ。
 *   - per-row の reporter 一致判定はサービス層 (`bulkUpdateRisksFromList`) で実施し、
 *     他人作成のレコードは silently skip する (admin であっても他人のリスクは更新不可)。
 *
 * 安全策:
 *   1. **フィルター必須**: filterFingerprint に何も指定が無い場合は 400 で拒否
 *      (UI チェックボックスを外して全件選択 → 全件 update の事故を防ぐ二重防御)
 *   2. **patch 全省略禁止**: validator schema 側で no-op patch を 400
 *   3. **ids 上限 500**: 1 リクエストで暴走しないよう絞る
 *   4. **projectId scope**: where 句に projectId を含めるため、ids に他プロジェクトの
 *      レコードが混ざってもサービス層で skippedNotFound 扱い (= 触れない)
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { projectId } = await params;

  // 'risk:update' で「自分が起票したリスクは編集可」を満たす最低限のロール (member 含む) を要求。
  // per-row 判定はサービス層で行うため、ここでは resourceOwnerId を渡さず member 全員に通す。
  const forbidden = await checkProjectPermission(user, projectId, 'risk:update');
  if (forbidden) return forbidden;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const parsed = bulkUpdateRisksSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'VALIDATION_ERROR', details: parsed.error.format() },
      { status: 400 },
    );
  }

  if (!isFilterApplied(parsed.data.filterFingerprint)) {
    const t = await getTranslations('message');
    return NextResponse.json(
      { error: 'FILTER_REQUIRED', message: t('filterRequiredForBulk') },
      { status: 400 },
    );
  }

  const result = await bulkUpdateRisksFromList(
    projectId,
    parsed.data.ids,
    parsed.data.patch,
    user.id,
  );

  return NextResponse.json({ data: result });
}
