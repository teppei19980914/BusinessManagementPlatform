/**
 * 手動リンクサービス (v1.3.0 資産導線機能)
 *
 * 役割:
 *   Risk / Issue / Knowledge / Retrospective / Memo の 5 資産間で「既存 ↔ 既存」を
 *   結ぶ汎用手動リンクを管理する。昇華リンク (promotion.service.ts) とは異なり、
 *   新規レコードは作成しない。リンク対象は公開可視状態の資産のみに限定する
 *   (draft/private は他者から不可視のため、リンク UI にも出さない方針。
 *   本サービスでも defense-in-depth として再検証する)。
 *
 * 設計判断:
 *   - A→B と B→A は同一リンクとみなす (対称重複防止)。作成時に両方向を検索して
 *     既存なら ALREADY_LINKED で弾く。
 *   - asset_links の entity 列はポリモーフィック (FK なし、Prisma 仕様上不可)。
 *     エンティティが論理削除されると孤立リンクが残るため、各エンティティの
 *     delete service 関数から deleteAssetLinksForEntity を呼び出して同時に
 *     クリーンアップする (PR-3 で各 deleteXxx に結線)。
 *   - Retrospective には title 列が存在しない (schema.prisma 確認済)。表示用ラベルは
 *     呼出元 (UI) が conductedDate から組み立てる前提で、本サービスは
 *     title: null + conductedDate を返す。
 *   - tenantId は全関数で必須 (severity-1 テナント越境防止)。
 */

import { prisma } from '@/lib/db';
import { LINKABLE_ENTITY_TYPES, type LinkableEntityType } from '@/lib/validators/asset-link';

export function isLinkableEntityType(value: string): value is LinkableEntityType {
  return (LINKABLE_ENTITY_TYPES as readonly string[]).includes(value);
}

export type LinkedEntitySummary = {
  entityType: LinkableEntityType;
  entityId: string;
  /** Retrospective は title 列を持たないため null (UI が conductedDate からラベルを組み立てる) */
  title: string | null;
  /** Retrospective のみ値を持つ ('YYYY-MM-DD') */
  conductedDate: string | null;
  visibility: string;
};

export type AssetLinkSummary = {
  linkId: string;
  createdAt: string;
  createdBy: string;
  entity: LinkedEntitySummary;
};

/**
 * エンティティ種別ごとの「公開可視」 where 条件 (論理削除済みを除く)。
 * risk/issue は RiskIssue.type で区別、それ以外は visibility のみで判定する。
 */
export function getPubliclyVisibleFilter(entityType: LinkableEntityType) {
  switch (entityType) {
    case 'risk':
    case 'issue':
      return { deletedAt: null, type: entityType, visibility: 'public' as const };
    case 'knowledge':
    case 'retrospective':
    case 'memo':
      return { deletedAt: null, visibility: 'public' as const };
  }
}

async function findPublicEntity(
  entityType: LinkableEntityType,
  entityId: string,
  tenantId: string,
): Promise<LinkedEntitySummary | null> {
  switch (entityType) {
    case 'risk':
    case 'issue': {
      const row = await prisma.riskIssue.findFirst({
        where: { id: entityId, tenantId, ...getPubliclyVisibleFilter(entityType) },
        select: { id: true, title: true, visibility: true },
      });
      if (!row) return null;
      return { entityType, entityId: row.id, title: row.title, conductedDate: null, visibility: row.visibility };
    }
    case 'knowledge': {
      const row = await prisma.knowledge.findFirst({
        where: { id: entityId, tenantId, ...getPubliclyVisibleFilter(entityType) },
        select: { id: true, title: true, visibility: true },
      });
      if (!row) return null;
      return { entityType, entityId: row.id, title: row.title, conductedDate: null, visibility: row.visibility };
    }
    case 'retrospective': {
      const row = await prisma.retrospective.findFirst({
        where: { id: entityId, tenantId, ...getPubliclyVisibleFilter(entityType) },
        select: { id: true, conductedDate: true, visibility: true },
      });
      if (!row) return null;
      return {
        entityType,
        entityId: row.id,
        title: null,
        conductedDate: row.conductedDate.toISOString().split('T')[0],
        visibility: row.visibility,
      };
    }
    case 'memo': {
      const row = await prisma.memo.findFirst({
        where: { id: entityId, tenantId, ...getPubliclyVisibleFilter(entityType) },
        select: { id: true, title: true, visibility: true },
      });
      if (!row) return null;
      return { entityType, entityId: row.id, title: row.title, conductedDate: null, visibility: row.visibility };
    }
  }
}

/**
 * 公開可視エンティティかどうかを検証する (リンク作成時の defense-in-depth、
 * 将来のリンク先候補検索 API でも同じ判定を使う想定)。
 */
export async function isPublicEntity(
  entityType: LinkableEntityType,
  entityId: string,
  tenantId: string,
): Promise<boolean> {
  return (await findPublicEntity(entityType, entityId, tenantId)) !== null;
}

/**
 * 既存資産間の手動リンクを作成する。
 *
 * @throws {Error} 'INVALID_ENTITY_TYPE' — entityType が5種以外
 * @throws {Error} 'SELF_LINK_FORBIDDEN' — 同一エンティティへのリンク
 * @throws {Error} 'FROM_NOT_FOUND' — リンク元が存在しない/非公開/他テナント
 * @throws {Error} 'TO_NOT_FOUND' — リンク先が存在しない/非公開/他テナント
 * @throws {Error} 'ALREADY_LINKED' — 既に同じ組 (A→B または B→A) のリンクが存在
 */
export async function createAssetLink(
  fromEntityType: LinkableEntityType,
  fromEntityId: string,
  toEntityType: LinkableEntityType,
  toEntityId: string,
  userId: string,
  tenantId: string,
): Promise<AssetLinkSummary> {
  if (!isLinkableEntityType(fromEntityType) || !isLinkableEntityType(toEntityType)) {
    throw new Error('INVALID_ENTITY_TYPE');
  }
  if (fromEntityType === toEntityType && fromEntityId === toEntityId) {
    throw new Error('SELF_LINK_FORBIDDEN');
  }

  const [fromEntity, toEntity] = await Promise.all([
    findPublicEntity(fromEntityType, fromEntityId, tenantId),
    findPublicEntity(toEntityType, toEntityId, tenantId),
  ]);
  if (!fromEntity) throw new Error('FROM_NOT_FOUND');
  if (!toEntity) throw new Error('TO_NOT_FOUND');

  const existing = await prisma.assetLink.findFirst({
    where: {
      tenantId,
      OR: [
        { fromEntityType, fromEntityId, toEntityType, toEntityId },
        {
          fromEntityType: toEntityType,
          fromEntityId: toEntityId,
          toEntityType: fromEntityType,
          toEntityId: fromEntityId,
        },
      ],
    },
    select: { id: true },
  });
  if (existing) throw new Error('ALREADY_LINKED');

  const link = await prisma.assetLink.create({
    data: { tenantId, fromEntityType, fromEntityId, toEntityType, toEntityId, createdBy: userId },
  });

  return {
    linkId: link.id,
    createdAt: link.createdAt.toISOString(),
    createdBy: link.createdBy,
    entity: toEntity,
  };
}

/**
 * 指定リンクを削除する (作成者のみ削除可。tenantId スコープ必須)。
 *
 * @returns 削除できたら true。リンクが存在しない/他テナント/作成者でない場合は false
 *   (404 と 403 を区別せず info leak を避ける、deleteMemo 等と同じ方針)
 */
export async function deleteAssetLink(linkId: string, userId: string, tenantId: string): Promise<boolean> {
  const result = await prisma.assetLink.deleteMany({
    where: { id: linkId, tenantId, createdBy: userId },
  });
  return result.count > 0;
}

/**
 * 指定エンティティに紐づく手動リンクを双方向で取得する
 * (詳細画面の「関連資産」セクション用)。相手が論理削除済み/非公開/他テナントの場合は
 * 結果から除外する (リンク行自体は孤立リンク削除まで残るが、表示はしない)。
 */
export async function getAssetLinks(
  entityType: LinkableEntityType,
  entityId: string,
  tenantId: string,
): Promise<AssetLinkSummary[]> {
  const rows = await prisma.assetLink.findMany({
    where: {
      tenantId,
      OR: [
        { fromEntityType: entityType, fromEntityId: entityId },
        { toEntityType: entityType, toEntityId: entityId },
      ],
    },
    orderBy: { createdAt: 'desc' },
  });

  const results = await Promise.all(
    rows.map(async (row): Promise<AssetLinkSummary | null> => {
      const isFrom = row.fromEntityType === entityType && row.fromEntityId === entityId;
      const otherType = (isFrom ? row.toEntityType : row.fromEntityType) as LinkableEntityType;
      const otherId = isFrom ? row.toEntityId : row.fromEntityId;
      const entity = await findPublicEntity(otherType, otherId, tenantId);
      if (!entity) return null;
      return {
        linkId: row.id,
        createdAt: row.createdAt.toISOString(),
        createdBy: row.createdBy,
        entity,
      };
    }),
  );

  return results.filter((r): r is AssetLinkSummary => r !== null);
}

const CANDIDATE_LIMIT = 20;

/**
 * 手動リンク追加 UI の候補検索 (公開可視のみ、自分自身は除外)。
 * Retrospective は title 列が無いため planSummary/actualSummary を対象に LIKE 検索する。
 */
export async function searchLinkCandidates(
  entityType: LinkableEntityType,
  query: string,
  tenantId: string,
  excludeEntityId?: string,
): Promise<LinkedEntitySummary[]> {
  const q = query.trim();
  switch (entityType) {
    case 'risk':
    case 'issue': {
      const rows = await prisma.riskIssue.findMany({
        where: {
          tenantId,
          ...getPubliclyVisibleFilter(entityType),
          ...(excludeEntityId ? { id: { not: excludeEntityId } } : {}),
          ...(q ? { title: { contains: q, mode: 'insensitive' as const } } : {}),
        },
        select: { id: true, title: true, visibility: true },
        orderBy: { updatedAt: 'desc' },
        take: CANDIDATE_LIMIT,
      });
      return rows.map((r) => ({ entityType, entityId: r.id, title: r.title, conductedDate: null, visibility: r.visibility }));
    }
    case 'knowledge': {
      const rows = await prisma.knowledge.findMany({
        where: {
          tenantId,
          ...getPubliclyVisibleFilter(entityType),
          ...(excludeEntityId ? { id: { not: excludeEntityId } } : {}),
          ...(q ? { title: { contains: q, mode: 'insensitive' as const } } : {}),
        },
        select: { id: true, title: true, visibility: true },
        orderBy: { updatedAt: 'desc' },
        take: CANDIDATE_LIMIT,
      });
      return rows.map((r) => ({ entityType, entityId: r.id, title: r.title, conductedDate: null, visibility: r.visibility }));
    }
    case 'retrospective': {
      const rows = await prisma.retrospective.findMany({
        where: {
          tenantId,
          ...getPubliclyVisibleFilter(entityType),
          ...(excludeEntityId ? { id: { not: excludeEntityId } } : {}),
          ...(q
            ? {
                OR: [
                  { planSummary: { contains: q, mode: 'insensitive' as const } },
                  { actualSummary: { contains: q, mode: 'insensitive' as const } },
                ],
              }
            : {}),
        },
        select: { id: true, conductedDate: true, visibility: true },
        orderBy: { conductedDate: 'desc' },
        take: CANDIDATE_LIMIT,
      });
      return rows.map((r) => ({
        entityType,
        entityId: r.id,
        title: null,
        conductedDate: r.conductedDate.toISOString().split('T')[0],
        visibility: r.visibility,
      }));
    }
    case 'memo': {
      const rows = await prisma.memo.findMany({
        where: {
          tenantId,
          ...getPubliclyVisibleFilter(entityType),
          ...(excludeEntityId ? { id: { not: excludeEntityId } } : {}),
          ...(q ? { title: { contains: q, mode: 'insensitive' as const } } : {}),
        },
        select: { id: true, title: true, visibility: true },
        orderBy: { updatedAt: 'desc' },
        take: CANDIDATE_LIMIT,
      });
      return rows.map((r) => ({ entityType, entityId: r.id, title: r.title, conductedDate: null, visibility: r.visibility }));
    }
  }
}

/**
 * エンティティ削除時の孤立リンク除去 (PR-3: deleteRisk / deleteKnowledge /
 * deleteRetrospective / deleteMemo から呼び出す)。
 * 削除対象エンティティが from/to どちらに入っていても一括で除去する。
 */
export async function deleteAssetLinksForEntity(
  entityType: LinkableEntityType,
  entityId: string,
  tenantId: string,
): Promise<number> {
  const result = await prisma.assetLink.deleteMany({
    where: {
      tenantId,
      OR: [
        { fromEntityType: entityType, fromEntityId: entityId },
        { toEntityType: entityType, toEntityId: entityId },
      ],
    },
  });
  return result.count;
}
