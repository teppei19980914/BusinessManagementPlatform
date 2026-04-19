import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { prisma } from '@/lib/db';
import { ATTACHMENT_ENTITY_TYPES } from '@/lib/validators/attachment';
import type { AttachmentEntityType } from '@/lib/validators/attachment';
import type { AttachmentDTO } from '@/services/attachment.service';

/**
 * POST /api/attachments/batch
 *
 * 一覧画面で各行の添付リンクを列として表示するために使うバッチ取得 API (PR #67)。
 * 個別に `/api/attachments?entityType=&entityId=` を N 回叩くと N+1 になるため、
 * エンティティ ID の配列を受けて一括で取り出す。
 *
 * 認可方針 (Phase 1): ログインユーザなら全件返す (非メンバーのエンティティは既に
 * サーバ側の一覧クエリで除外されている前提)。将来、エンティティ種別ごとに厳密に
 * 権限判定したい場合は本関数でメンバーシップを確認する。
 *
 * レスポンス: Map 形式 ({ [entityId]: AttachmentDTO[] }) で返し、UI 側の
 * lookup を O(1) にする。
 */

const bodySchema = z.object({
  entityType: z.enum(ATTACHMENT_ENTITY_TYPES),
  entityIds: z.array(z.string().uuid()).max(500), // 1 リクエストの上限
  slot: z.string().max(30).optional(),
});

export async function POST(req: NextRequest) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const body = await req.json().catch(() => ({}));
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', details: parsed.error.issues } },
      { status: 400 },
    );
  }
  const { entityType, entityIds, slot } = parsed.data;
  if (entityIds.length === 0) {
    return NextResponse.json({ data: {} });
  }

  const rows = await prisma.attachment.findMany({
    where: {
      entityType,
      entityId: { in: entityIds },
      slot: slot ?? undefined,
      deletedAt: null,
    },
    include: { addedByUser: { select: { name: true } } },
    orderBy: [{ slot: 'asc' }, { createdAt: 'asc' }],
  });

  // Entity ID をキーにグルーピング (O(1) lookup のため)
  const byEntity: Record<string, AttachmentDTO[]> = {};
  for (const r of rows) {
    const dto: AttachmentDTO = {
      id: r.id,
      entityType: r.entityType,
      entityId: r.entityId,
      slot: r.slot,
      displayName: r.displayName,
      url: r.url,
      mimeHint: r.mimeHint,
      addedBy: r.addedBy,
      addedByName: r.addedByUser?.name ?? null,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
    if (!byEntity[r.entityId]) byEntity[r.entityId] = [];
    byEntity[r.entityId].push(dto);
  }

  // 変数名で lint エラーにならないよう entityType を使用
  void (entityType satisfies AttachmentEntityType);
  return NextResponse.json({ data: byEntity });
}
