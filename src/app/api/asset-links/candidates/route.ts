/**
 * GET /api/asset-links/candidates - 手動リンク追加 UI の候補検索 (v1.3.0 資産導線機能)
 *
 * クエリパラメータ:
 *   - entityType        : 検索対象の資産種別 (LINKABLE_ENTITY_TYPES)
 *   - query             : 部分一致フィルタ (任意、大文字小文字無視)
 *   - excludeEntityId   : 結果から除外する ID (リンク元自身、自己リンク防止用に任意)
 *
 * 認可: 認証済みユーザなら可 (返す候補は公開可視の資産のみ、自テナント限定)。
 */

import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from 'next-intl/server';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { LINKABLE_ENTITY_TYPES } from '@/lib/validators/asset-link';
import type { LinkableEntityType } from '@/lib/validators/asset-link';
import { searchLinkCandidates } from '@/services/asset-link.service';

export async function GET(req: NextRequest) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const url = new URL(req.url);
  const entityType = url.searchParams.get('entityType');
  const query = url.searchParams.get('query') ?? '';
  const excludeEntityId = url.searchParams.get('excludeEntityId') ?? undefined;

  if (!entityType || !LINKABLE_ENTITY_TYPES.includes(entityType as LinkableEntityType)) {
    const t = await getTranslations('message');
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', message: t('invalidRequest') } },
      { status: 400 },
    );
  }

  const data = await searchLinkCandidates(entityType as LinkableEntityType, query, user.tenantId, excludeEntityId);
  return NextResponse.json({ data });
}
