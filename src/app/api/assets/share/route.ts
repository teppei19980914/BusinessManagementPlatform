/**
 * POST /api/assets/share - 公開資産をテナントメンバーに共有 (v1.5.0)
 *
 * リクエストボディ:
 *   { entityType: 'knowledge' | 'risk' | 'issue' | 'retrospective' | 'memo',
 *     entityId: string (UUID),
 *     recipientUserIds: string[] (1 件以上) }
 *
 * 認可:
 *   - 認証済ユーザのみ
 *   - 対象資産が visibility='public' かつ送信者と同テナントであること
 *   - 受信者が全員、送信者と同テナントの有効ユーザ (isActive=true / deletedAt=null / permanentLock=false)
 *
 * 動作:
 *   - 自分自身が recipientUserIds に含まれていても service 層で自動除外 (エラーにしない)
 *   - 通知は createMany + skipDuplicates でバッチ送信 (dedupeKey はタイムスタンプ+インデックスで UNIQUE を満たす)
 *
 * レスポンス:
 *   200: { data: { count: number } }  ← 実際に送信された通知件数 (自己除外後)
 *   400: VALIDATION_ERROR
 *   404: NOT_FOUND (資産が非公開 / 削除済 / 別テナント)
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { prisma } from '@/lib/db';
import { buildEntityCommentLink } from '@/lib/entity-link';
import { shareAsset } from '@/services/notification.service';

const SHARE_ENTITY_TYPES = ['knowledge', 'risk', 'issue', 'retrospective', 'memo'] as const;
type ShareEntityType = (typeof SHARE_ENTITY_TYPES)[number];

const shareAssetBodySchema = z.object({
  entityType: z.enum(SHARE_ENTITY_TYPES),
  entityId: z.string().uuid(),
  recipientUserIds: z.array(z.string().uuid()).min(1).max(100),
});

/** entityType + entityId に対応する公開資産を返す。非公開・削除済・別テナントなら null。 */
async function resolvePublicAsset(
  entityType: ShareEntityType,
  entityId: string,
  tenantId: string,
): Promise<{ title: string } | null> {
  switch (entityType) {
    case 'knowledge':
      return prisma.knowledge.findFirst({
        where: { id: entityId, tenantId, visibility: 'public', deletedAt: null },
        select: { title: true },
      });
    case 'risk':
      return prisma.riskIssue.findFirst({
        where: { id: entityId, tenantId, type: 'risk', visibility: 'public', deletedAt: null },
        select: { title: true },
      });
    case 'issue':
      return prisma.riskIssue.findFirst({
        where: { id: entityId, tenantId, type: 'issue', visibility: 'public', deletedAt: null },
        select: { title: true },
      });
    case 'retrospective': {
      const retro = await prisma.retrospective.findFirst({
        where: { id: entityId, tenantId, visibility: 'public', deletedAt: null },
        select: { conductedDate: true },
      });
      if (!retro) return null;
      return { title: retro.conductedDate.toISOString().slice(0, 10) };
    }
    case 'memo':
      return prisma.memo.findFirst({
        where: { id: entityId, tenantId, visibility: 'public', deletedAt: null },
        select: { title: true },
      });
  }
}

export async function POST(req: NextRequest) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const body = await req.json();
  const parsed = shareAssetBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', details: parsed.error.issues } },
      { status: 400 },
    );
  }

  const { entityType, entityId, recipientUserIds } = parsed.data;

  // 資産の存在 + visibility='public' + 同テナントを一括確認
  const asset = await resolvePublicAsset(entityType, entityId, user.tenantId);
  if (!asset) {
    return NextResponse.json(
      {
        error: {
          code: 'NOT_FOUND',
          message: '共有対象の資産が見つかりません（非公開または削除済み）',
        },
      },
      { status: 404 },
    );
  }

  // 受信者が全員同テナントの有効ユーザかを確認 (テナント越境 + 無効アカウントへの誤送防止)
  const validRecipients = await prisma.user.findMany({
    where: {
      id: { in: recipientUserIds },
      tenantId: user.tenantId,
      isActive: true,
      deletedAt: null,
      permanentLock: false,
    },
    select: { id: true },
  });
  const validIdSet = new Set(validRecipients.map((u) => u.id));
  const invalidIds = recipientUserIds.filter((id) => !validIdSet.has(id));
  if (invalidIds.length > 0) {
    return NextResponse.json(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: '指定されたユーザの一部が有効でないか、別テナントに属しています',
        },
      },
      { status: 400 },
    );
  }

  const link = await buildEntityCommentLink(entityType, entityId);

  const { count } = await shareAsset({
    entityType,
    entityId,
    senderUserId: user.id,
    senderDisplayName: user.name,
    recipientUserIds,
    assetTitle: asset.title,
    link,
    tenantId: user.tenantId,
  });

  return NextResponse.json({ data: { count } });
}
