import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { bulkUpdateMemosVisibilityFromList } from '@/services/memo.service';
import {
  bulkUpdateMemoVisibilitySchema,
  isCrossListFilterApplied,
} from '@/lib/validators/cross-list-bulk-visibility';

/**
 * 個人「メモ一覧」(/memos) からの一括 visibility 更新 (PR #165 で /memos に移し替え、
 * 元実装は PR #162 /all-memos cross-list 用)。
 *
 * Memo は project に紐付かない個人ノートで、編集権限は元から作成者本人のみ。
 * scope は viewerUserId 自身のメモのみ (path は /api/memos/bulk のまま personal scope)。
 *
 * 注: validator ファイル名 (cross-list-bulk-visibility.ts) と関数名 (isCrossListFilterApplied)
 * は元のまま流用する。本来はリネーム候補だが、Memo の場合は cross-list ではなく
 * personal-list 用途のため命名が誤解を招く。後続 PR でリネームを検討。
 *
 * Memo は visibility 値域が `private` / `public` (DB schema) なので
 * 共通 schema は entity 別の enum に分かれている。
 *
 * 認可: 認証済みユーザならアクセス可、サービス層で per-row 作成者判定 + silent skip。
 * 安全策: filterFingerprint が空なら 400 FILTER_REQUIRED で拒否。
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

  const parsed = bulkUpdateMemoVisibilitySchema.safeParse(body);
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

  const result = await bulkUpdateMemosVisibilityFromList(
    parsed.data.ids,
    parsed.data.visibility,
    user.id,
  );

  return NextResponse.json({ data: result });
}
