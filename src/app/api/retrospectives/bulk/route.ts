import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { bulkUpdateRetrospectivesVisibilityFromCrossList } from '@/services/retrospective.service';
import {
  bulkUpdateRetrospectiveVisibilitySchema,
  isCrossListFilterApplied,
} from '@/lib/validators/cross-list-bulk-visibility';

/**
 * 「全振り返り」横断ビューからの一括 visibility 更新 (PR #162 / Phase 2)。
 *
 * 認可: 認証済みユーザならアクセス可、サービス層で per-row 作成者判定 + silent skip。
 * 安全策: filterFingerprint が空なら 400 FILTER_REQUIRED で拒否 (PR #161 と同方針の二重防御)。
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

  const parsed = bulkUpdateRetrospectiveVisibilitySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'VALIDATION_ERROR', details: parsed.error.format() },
      { status: 400 },
    );
  }

  if (!isCrossListFilterApplied(parsed.data.filterFingerprint)) {
    return NextResponse.json(
      { error: 'FILTER_REQUIRED', message: 'フィルターを 1 つ以上適用してください (全件更新の事故防止)' },
      { status: 400 },
    );
  }

  const result = await bulkUpdateRetrospectivesVisibilityFromCrossList(
    parsed.data.ids,
    parsed.data.visibility,
    user.id,
  );

  return NextResponse.json({ data: result });
}
