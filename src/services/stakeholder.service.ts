/**
 * ステークホルダー管理サービス (PMBOK 13)
 *
 * 役割:
 *   プロジェクトに関与する全関係者 (内部メンバー + 外部関係者) を 1 テーブルで管理し、
 *   Mendelow Power/Interest grid + 姿勢 + Engagement Gap で対応戦略を整理する。
 *
 * 設計判断:
 *   - 内部 / 外部の統一テーブル: userId は nullable FK。User.name と独立した name 列を
 *     持たせ、敬称付き表記や所属表現の自由度を確保。
 *   - influence / interest: 1-5 段階で格納。UI は閾値 >= 4 で 4 象限分類するが、生値を
 *     保持することで将来 5x5 ヒートマップにも丸められる。
 *   - 姿勢 (attitude): supportive / neutral / opposing。同じ象限でも対応戦略が変わる
 *     ため必須項目とする。
 *   - Engagement Gap (PMBOK 13.1.2): currentEngagement と desiredEngagement の差分が
 *     アクション必要度の指標になる。サービス層で計算した値を DTO に含めて返す。
 *   - 認可: 個人情報 (連絡先・人物評) を含むため呼出側で stakeholder:* アクションを
 *     チェックする (PM/TL + admin のみ通過)。
 *   - 論理削除 (deletedAt) を採用。プロジェクトクローズ後も振り返り資料として参照する。
 *
 * 関連ドキュメント:
 *   - DESIGN.md (テーブル定義: stakeholders / 認可: stakeholder アクション)
 *   - SPECIFICATION.md (ステークホルダー画面)
 *   - REQUIREMENTS.md (ステークホルダー管理簿)
 */

import { prisma } from '@/lib/db';
import {
  classifyStakeholderQuadrant,
  calcEngagementGap,
  type StakeholderAttitude,
  type StakeholderEngagement,
  type StakeholderQuadrant,
} from '@/config/master-data';
import type {
  CreateStakeholderInput,
  UpdateStakeholderInput,
} from '@/lib/validators/stakeholder';

export type StakeholderDTO = {
  id: string;
  projectId: string;
  userId: string | null;
  /** 内部紐付け時の表示用ユーザ名 (Stakeholder.name とは別系列の参考情報) */
  linkedUserName: string | null;
  name: string;
  organization: string | null;
  role: string | null;
  contactInfo: string | null;
  influence: number;
  interest: number;
  attitude: StakeholderAttitude;
  currentEngagement: StakeholderEngagement;
  desiredEngagement: StakeholderEngagement;
  /** desired - current。正なら強める方向、負なら抑える方向の働きかけが必要。0 で目標達成。 */
  engagementGap: number;
  /** Power/Interest grid 4 象限 (UI バッジ表示・ソート用) */
  quadrant: StakeholderQuadrant;
  personality: string | null;
  tags: string[];
  strategy: string | null;
  createdAt: string;
  updatedAt: string;
};

type StakeholderRow = {
  id: string;
  projectId: string;
  userId: string | null;
  user?: { name: string } | null;
  name: string;
  organization: string | null;
  role: string | null;
  contactInfo: string | null;
  influence: number;
  interest: number;
  attitude: string;
  currentEngagement: string;
  desiredEngagement: string;
  personality: string | null;
  tags: unknown; // Prisma Json
  strategy: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function toStakeholderDTO(s: StakeholderRow): StakeholderDTO {
  const attitude = s.attitude as StakeholderAttitude;
  const current = s.currentEngagement as StakeholderEngagement;
  const desired = s.desiredEngagement as StakeholderEngagement;
  // tags は JsonB なので unknown 型。配列以外が入っていれば空配列にフォールバック。
  const tags = Array.isArray(s.tags)
    ? (s.tags as unknown[]).filter((t): t is string => typeof t === 'string')
    : [];
  return {
    id: s.id,
    projectId: s.projectId,
    userId: s.userId,
    linkedUserName: s.user?.name ?? null,
    name: s.name,
    organization: s.organization,
    role: s.role,
    contactInfo: s.contactInfo,
    influence: s.influence,
    interest: s.interest,
    attitude,
    currentEngagement: current,
    desiredEngagement: desired,
    engagementGap: calcEngagementGap(current, desired),
    quadrant: classifyStakeholderQuadrant(s.influence, s.interest),
    personality: s.personality,
    tags,
    strategy: s.strategy,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}

/**
 * プロジェクトのステークホルダー一覧を取得する。
 *
 * 認可は呼出側 (API route) で `stakeholder:read` を確認済の前提。
 * ソート: 影響度 desc → 関心度 desc (重要度上位を先頭に)。
 */
export async function listStakeholders(projectId: string): Promise<StakeholderDTO[]> {
  const rows = await prisma.stakeholder.findMany({
    where: { projectId, deletedAt: null },
    include: { user: { select: { name: true } } },
    orderBy: [
      { influence: 'desc' },
      { interest: 'desc' },
      { createdAt: 'desc' },
    ],
  });
  return rows.map(toStakeholderDTO);
}

/**
 * 単一ステークホルダーを取得する。
 * 認可オフの内部呼び出し (existing 検証用) は viewerUserId を省略可。
 */
export async function getStakeholder(stakeholderId: string): Promise<StakeholderDTO | null> {
  const row = await prisma.stakeholder.findFirst({
    where: { id: stakeholderId, deletedAt: null },
    include: { user: { select: { name: true } } },
  });
  if (!row) return null;
  return toStakeholderDTO(row);
}

export async function createStakeholder(
  projectId: string,
  input: CreateStakeholderInput,
  userId: string,
): Promise<StakeholderDTO> {
  const row = await prisma.stakeholder.create({
    data: {
      projectId,
      userId: input.userId ?? null,
      name: input.name,
      organization: input.organization ?? null,
      role: input.role ?? null,
      contactInfo: input.contactInfo ?? null,
      influence: input.influence,
      interest: input.interest,
      attitude: input.attitude,
      currentEngagement: input.currentEngagement,
      desiredEngagement: input.desiredEngagement,
      personality: input.personality ?? null,
      tags: input.tags ?? [],
      strategy: input.strategy ?? null,
      createdBy: userId,
      updatedBy: userId,
    },
    include: { user: { select: { name: true } } },
  });
  return toStakeholderDTO(row);
}

/**
 * ステークホルダーを更新する。
 *
 * 認可は呼出側で `stakeholder:update` を確認済の前提 (PM/TL + admin のみ通過)。
 * `risk:update` のような「作成者本人のみ」制約は意図的に設けない (PM 交代があっても
 * 後任 PM がそのまま編集を引き継げるよう、プロジェクト単位で共同管理する設計)。
 *
 * @throws {Error} 'NOT_FOUND' — 存在しない or 論理削除済み
 */
export async function updateStakeholder(
  stakeholderId: string,
  input: UpdateStakeholderInput,
  userId: string,
): Promise<StakeholderDTO> {
  const existing = await prisma.stakeholder.findFirst({
    where: { id: stakeholderId, deletedAt: null },
    select: { id: true },
  });
  if (!existing) throw new Error('NOT_FOUND');

  const data: Record<string, unknown> = { updatedBy: userId };
  if (input.userId !== undefined) data.userId = input.userId;
  if (input.name !== undefined) data.name = input.name;
  if (input.organization !== undefined) data.organization = input.organization;
  if (input.role !== undefined) data.role = input.role;
  if (input.contactInfo !== undefined) data.contactInfo = input.contactInfo;
  if (input.influence !== undefined) data.influence = input.influence;
  if (input.interest !== undefined) data.interest = input.interest;
  if (input.attitude !== undefined) data.attitude = input.attitude;
  if (input.currentEngagement !== undefined) data.currentEngagement = input.currentEngagement;
  if (input.desiredEngagement !== undefined) data.desiredEngagement = input.desiredEngagement;
  if (input.personality !== undefined) data.personality = input.personality;
  if (input.tags !== undefined) data.tags = input.tags;
  if (input.strategy !== undefined) data.strategy = input.strategy;

  const row = await prisma.stakeholder.update({
    where: { id: stakeholderId },
    data,
    include: { user: { select: { name: true } } },
  });
  return toStakeholderDTO(row);
}

/**
 * ステークホルダーを論理削除する。
 *
 * 認可は呼出側で `stakeholder:delete` を確認済の前提。
 *
 * @throws {Error} 'NOT_FOUND' — 存在しない or 既に削除済み
 */
export async function deleteStakeholder(stakeholderId: string, userId: string): Promise<void> {
  const existing = await prisma.stakeholder.findFirst({
    where: { id: stakeholderId, deletedAt: null },
    select: { id: true },
  });
  if (!existing) throw new Error('NOT_FOUND');

  await prisma.stakeholder.update({
    where: { id: stakeholderId },
    data: { deletedAt: new Date(), updatedBy: userId },
  });
}
