/**
 * GET  /api/asset-links?entityType=...&entityId=... - 手動リンク一覧取得
 * POST /api/asset-links                              - 手動リンク新規作成
 *
 * 役割:
 *   Risk / Issue / Knowledge / Retrospective / Memo の5資産間の汎用手動リンク
 *   (v1.3.0 資産導線機能)。昇華リンク (promotion.service.ts) とは別経路。
 *
 * 認可:
 *   comments の public エンティティ読み書きと同じ方針 — 認証済みユーザなら誰でも
 *   作成/閲覧可 (リンク対象は公開可視の資産のみに service 層で限定される)。
 *   プロジェクトメンバーシップは不問 (リンク先がそもそも project 不問の資産も含むため)。
 *
 * 監査: POST 時に audit_logs (entityType='asset_link', action='CREATE') を記録。
 */

import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from 'next-intl/server';
import { getAuthenticatedUser, requireStorageQuotaForWrite } from '@/lib/api-helpers';
import { createAssetLinkSchema, LINKABLE_ENTITY_TYPES } from '@/lib/validators/asset-link';
import type { LinkableEntityType } from '@/lib/validators/asset-link';
import { createAssetLink, getAssetLinks } from '@/services/asset-link.service';
import { recordAuditLog } from '@/services/audit.service';

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
  if (!LINKABLE_ENTITY_TYPES.includes(entityType as LinkableEntityType)) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', message: t('invalidRequest') } },
      { status: 400 },
    );
  }

  const data = await getAssetLinks(entityType as LinkableEntityType, entityId, user.tenantId);
  return NextResponse.json({ data });
}

export async function POST(req: NextRequest) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const body = await req.json();
  const parsed = createAssetLinkSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', details: parsed.error.issues } },
      { status: 400 },
    );
  }
  const { fromEntityType, fromEntityId, toEntityType, toEntityId } = parsed.data;

  const quotaErr = await requireStorageQuotaForWrite(
    user.tenantId,
    Buffer.byteLength(JSON.stringify(parsed.data), 'utf8'),
  );
  if (quotaErr) return quotaErr;

  let link;
  try {
    link = await createAssetLink(
      fromEntityType,
      fromEntityId,
      toEntityType,
      toEntityId,
      user.id,
      user.tenantId,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === 'SELF_LINK_FORBIDDEN') {
      return NextResponse.json(
        {
          error: {
            code: 'SELF_LINK_FORBIDDEN',
            message: '同じ資産同士をリンクすることはできません',
          },
        },
        { status: 400 },
      );
    }
    if (msg === 'FROM_NOT_FOUND' || msg === 'TO_NOT_FOUND') {
      return NextResponse.json(
        {
          error: {
            code: 'NOT_FOUND',
            message: '公開済みの資産のみリンクできます (存在しない、または非公開の資産が指定されました)',
          },
        },
        { status: 404 },
      );
    }
    if (msg === 'ALREADY_LINKED') {
      return NextResponse.json(
        { error: { code: 'ALREADY_LINKED', message: 'この資産同士は既にリンクされています' } },
        { status: 409 },
      );
    }
    throw e;
  }

  await recordAuditLog({
    tenantId: user.tenantId,
    userId: user.id,
    action: 'CREATE',
    entityType: 'asset_link',
    entityId: link.linkId,
  });

  return NextResponse.json({ data: link }, { status: 201 });
}
