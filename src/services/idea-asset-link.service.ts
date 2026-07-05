/**
 * アイデアアセットリンクサービス (v1.5.0)
 *
 * アイデアセッション/スレッド (source) と既存プロジェクト資産 (target) を
 * ポリモーフィックな IdeaAssetLink テーブルで紐づける。
 *
 * 既存の AssetLink (資産間リンク) とは別テーブル・別サービス。
 * target は Task / Risk / Issue / Knowledge / Retrospective の 5 種。
 * source は voting_session / whiteboard_session / qa_thread の 3 種。
 *
 * FK なし (ポリモーフィック設計)。entity 削除時の孤立リンクはアプリ層でクリーンアップ。
 * リンク作成者 (createdBy) のみ削除可。
 */

import { prisma } from '@/lib/db';
import {
  IDEA_LINK_SOURCE_TYPES,
  IDEA_LINK_TARGET_TYPES,
  type IdeaLinkSourceType,
  type IdeaLinkTargetType,
} from '@/lib/validators/idea-session';

export function isIdeaLinkSourceType(value: string): value is IdeaLinkSourceType {
  return (IDEA_LINK_SOURCE_TYPES as readonly string[]).includes(value);
}

export function isIdeaLinkTargetType(value: string): value is IdeaLinkTargetType {
  return (IDEA_LINK_TARGET_TYPES as readonly string[]).includes(value);
}

// ============================================================
// DTO 型
// ============================================================

export type IdeaAssetLinkDTO = {
  id: string;
  sourceType: string;
  sourceId: string;
  targetType: string;
  targetId: string;
  createdBy: string;
  createdAt: string;
  /** target エンティティの表示タイトル (UI 表示用) */
  targetTitle: string | null;
};

// ============================================================
// 内部: target エンティティ確認 & タイトル取得
// ============================================================

async function getTargetTitle(
  targetType: IdeaLinkTargetType,
  targetId: string,
  tenantId: string,
): Promise<string | null> {
  switch (targetType) {
    case 'task': {
      const row = await prisma.task.findFirst({
        where: { id: targetId, deletedAt: null, project: { tenantId } },
        select: { name: true },
      });
      return row?.name ?? null;
    }
    case 'risk':
    case 'issue': {
      const row = await prisma.riskIssue.findFirst({
        where: { id: targetId, tenantId, type: targetType, deletedAt: null },
        select: { title: true },
      });
      return row?.title ?? null;
    }
    case 'knowledge': {
      const row = await prisma.knowledge.findFirst({
        where: { id: targetId, tenantId, deletedAt: null },
        select: { title: true },
      });
      return row?.title ?? null;
    }
    case 'retrospective': {
      const row = await prisma.retrospective.findFirst({
        where: { id: targetId, tenantId, deletedAt: null },
        select: { conductedDate: true },
      });
      return row ? row.conductedDate.toISOString().split('T')[0] : null;
    }
  }
}

// ============================================================
// Public API
// ============================================================

/**
 * アイデアソースに紐づくリンク一覧。
 */
export async function getIdeaAssetLinks(
  sourceType: IdeaLinkSourceType,
  sourceId: string,
  tenantId: string,
): Promise<IdeaAssetLinkDTO[]> {
  const rows = await prisma.ideaAssetLink.findMany({
    where: { tenantId, sourceType, sourceId },
    orderBy: { createdAt: 'desc' },
  });

  return Promise.all(
    rows.map(async (row) => {
      const title = await getTargetTitle(row.targetType as IdeaLinkTargetType, row.targetId, tenantId);
      return {
        id: row.id,
        sourceType: row.sourceType,
        sourceId: row.sourceId,
        targetType: row.targetType,
        targetId: row.targetId,
        createdBy: row.createdBy,
        createdAt: row.createdAt.toISOString(),
        targetTitle: title,
      };
    }),
  );
}

/**
 * target 資産に紐づくアイデアリンク逆引き一覧。
 */
export async function getIdeaAssetLinksByTarget(
  targetType: IdeaLinkTargetType,
  targetId: string,
  tenantId: string,
): Promise<IdeaAssetLinkDTO[]> {
  const rows = await prisma.ideaAssetLink.findMany({
    where: { tenantId, targetType, targetId },
    orderBy: { createdAt: 'desc' },
  });

  const title = await getTargetTitle(targetType, targetId, tenantId);
  return rows.map((row) => ({
    id: row.id,
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    targetType: row.targetType,
    targetId: row.targetId,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    targetTitle: title,
  }));
}

/**
 * リンク作成。重複は ALREADY_LINKED で弾く。
 *
 * @throws {Error} 'TARGET_NOT_FOUND' — 対象資産が存在しない/他テナント
 * @throws {Error} 'ALREADY_LINKED' — 既に同じリンクが存在
 */
export async function createIdeaAssetLink(
  sourceType: IdeaLinkSourceType,
  sourceId: string,
  targetType: IdeaLinkTargetType,
  targetId: string,
  userId: string,
  tenantId: string,
): Promise<IdeaAssetLinkDTO> {
  const targetTitle = await getTargetTitle(targetType, targetId, tenantId);
  if (targetTitle === null) throw new Error('TARGET_NOT_FOUND');

  const existing = await prisma.ideaAssetLink.findFirst({
    where: { tenantId, sourceType, sourceId, targetType, targetId },
    select: { id: true },
  });
  if (existing) throw new Error('ALREADY_LINKED');

  const link = await prisma.ideaAssetLink.create({
    data: { tenantId, sourceType, sourceId, targetType, targetId, createdBy: userId },
  });

  return {
    id: link.id,
    sourceType: link.sourceType,
    sourceId: link.sourceId,
    targetType: link.targetType,
    targetId: link.targetId,
    createdBy: link.createdBy,
    createdAt: link.createdAt.toISOString(),
    targetTitle,
  };
}

/**
 * リンク削除。作成者のみ削除可。
 *
 * @returns 削除できたら true (存在しない/作成者でない場合は false)
 */
export async function deleteIdeaAssetLink(
  linkId: string,
  userId: string,
  tenantId: string,
): Promise<boolean> {
  const result = await prisma.ideaAssetLink.deleteMany({
    where: { id: linkId, tenantId, createdBy: userId },
  });
  return result.count > 0;
}

/**
 * アイデアソース削除時の孤立リンク除去 (セッション/スレッド削除時に呼び出す)。
 */
export async function deleteIdeaAssetLinksForSource(
  sourceType: IdeaLinkSourceType,
  sourceId: string,
  tenantId: string,
): Promise<number> {
  const result = await prisma.ideaAssetLink.deleteMany({
    where: { tenantId, sourceType, sourceId },
  });
  return result.count;
}
