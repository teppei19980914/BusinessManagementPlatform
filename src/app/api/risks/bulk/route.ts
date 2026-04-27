import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { bulkUpdateRisksFromCrossList } from '@/services/risk.service';
import { bulkUpdateRisksSchema, isFilterApplied } from '@/lib/validators/risk-bulk';

/**
 * 「全リスク / 全課題」横断ビューからの一括更新エンドポイント (PR #161)。
 *
 * 認可:
 *   - 認証済みユーザならアクセス可。
 *   - 編集権限はサービス層で per-row 判定 (reporter 本人のみ更新)。
 *     他人のレコードを ids に混ぜても silently skip する。
 *
 * 安全策:
 *   1. **フィルター必須**: filterFingerprint に何も指定が無い場合は 400 で拒否
 *      (UI チェックボックスを外して全件選択 → 全件 update の事故を防ぐ)
 *   2. **patch 全省略禁止**: validator schema 側で no-op patch を 400
 *   3. **ids 上限 500**: 1 リクエストで暴走しないよう絞る
 */
export async function PATCH(req: NextRequest) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

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
    return NextResponse.json(
      { error: 'FILTER_REQUIRED', message: 'フィルターを 1 つ以上適用してください (全件更新の事故防止)' },
      { status: 400 },
    );
  }

  const result = await bulkUpdateRisksFromCrossList(
    parsed.data.ids,
    parsed.data.patch,
    user.id,
  );

  return NextResponse.json({ data: result });
}
