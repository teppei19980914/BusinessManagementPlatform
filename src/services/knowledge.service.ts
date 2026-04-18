import { prisma } from '@/lib/db';
import type { Prisma } from '@/generated/prisma/client';
import type { CreateKnowledgeInput } from '@/lib/validators/knowledge';

export type KnowledgeDTO = {
  id: string;
  title: string;
  knowledgeType: string;
  background: string;
  content: string;
  result: string;
  conclusion: string | null;
  recommendation: string | null;
  reusability: string | null;
  techTags: string[];
  devMethod: string | null;
  processTags: string[];
  visibility: string;
  createdBy: string;
  creatorName?: string;
  createdAt: string;
  updatedAt: string;
  projectIds?: string[];
};

function toKnowledgeDTO(k: {
  id: string;
  title: string;
  knowledgeType: string;
  background: string;
  content: string;
  result: string;
  conclusion: string | null;
  recommendation: string | null;
  reusability: string | null;
  techTags: Prisma.JsonValue;
  devMethod: string | null;
  processTags: Prisma.JsonValue;
  visibility: string;
  createdBy: string;
  creator?: { name: string };
  createdAt: Date;
  updatedAt: Date;
  knowledgeProjects?: { projectId: string }[];
}): KnowledgeDTO {
  return {
    id: k.id,
    title: k.title,
    knowledgeType: k.knowledgeType,
    background: k.background,
    content: k.content,
    result: k.result,
    conclusion: k.conclusion,
    recommendation: k.recommendation,
    reusability: k.reusability,
    techTags: (k.techTags as string[]) || [],
    devMethod: k.devMethod,
    processTags: (k.processTags as string[]) || [],
    visibility: k.visibility,
    createdBy: k.createdBy,
    creatorName: k.creator?.name,
    createdAt: k.createdAt.toISOString(),
    updatedAt: k.updatedAt.toISOString(),
    projectIds: k.knowledgeProjects?.map((kp) => kp.projectId),
  };
}

export type ListKnowledgeParams = {
  keyword?: string;
  knowledgeType?: string;
  visibility?: string;
  page?: number;
  limit?: number;
};

/**
 * ナレッジ一覧（公開範囲制御付き、PR #60 で 2 値体系に刷新）
 * - public: 全ログインユーザ閲覧可
 * - draft : 作成者 + admin のみ閲覧可
 */
export async function listKnowledge(
  params: ListKnowledgeParams,
  userId: string,
  systemRole: string,
): Promise<{ data: KnowledgeDTO[]; total: number }> {
  const page = params.page || 1;
  const limit = Math.min(params.limit || 20, 100);
  const skip = (page - 1) * limit;

  const where: Prisma.KnowledgeWhereInput = { deletedAt: null };

  // 公開範囲制御 (PR #60 で 2 値体系に刷新):
  //   - public: 全ログインユーザ閲覧可
  //   - draft : 作成者 + admin のみ
  if (systemRole !== 'admin') {
    where.OR = [
      { visibility: 'public' },
      { visibility: 'draft', createdBy: userId },
    ];
  }

  if (params.knowledgeType) {
    where.knowledgeType = params.knowledgeType;
  }
  if (params.visibility) {
    where.visibility = params.visibility;
  }
  if (params.keyword) {
    const keywordFilter = [
      { title: { contains: params.keyword, mode: 'insensitive' as const } },
      { content: { contains: params.keyword, mode: 'insensitive' as const } },
    ];
    if (where.OR) {
      // 公開範囲フィルタと AND で組み合わせ
      where.AND = [{ OR: where.OR }, { OR: keywordFilter }];
      delete where.OR;
    } else {
      where.OR = keywordFilter;
    }
  }

  const [knowledges, total] = await Promise.all([
    prisma.knowledge.findMany({
      where,
      include: {
        creator: { select: { name: true } },
        knowledgeProjects: { select: { projectId: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.knowledge.count({ where }),
  ]);

  return { data: knowledges.map(toKnowledgeDTO), total };
}

/**
 * 全ナレッジ横断ビュー用の拡張 DTO。
 * プロジェクトリンク情報と更新者氏名を追加し、非メンバー向けのマスキングに対応。
 * 複数プロジェクトに紐付いたナレッジは「最初の紐付け先」を主プロジェクトとして扱う。
 */
export type AllKnowledgeDTO = KnowledgeDTO & {
  primaryProjectId: string | null;
  projectName: string | null;
  projectDeleted: boolean;
  canAccessProject: boolean;
  linkedProjectCount: number;
  updatedByName: string | null;
};

/**
 * 全プロジェクト横断のナレッジを取得する (認可: ログインユーザなら誰でも可)。
 * 既存の公開範囲 (visibility) 制御は listKnowledge と同じ。
 * 非メンバー向けには主プロジェクト名・作成者氏名等をマスクする。
 */
export async function listAllKnowledgeForViewer(
  viewerUserId: string,
  viewerSystemRole: string,
): Promise<AllKnowledgeDTO[]> {
  const isAdmin = viewerSystemRole === 'admin';
  const memberships = isAdmin
    ? []
    : await prisma.projectMember.findMany({
      where: { userId: viewerUserId },
      select: { projectId: true },
    });
  const memberProjectIds = new Set(memberships.map((m) => m.projectId));

  const where: Prisma.KnowledgeWhereInput = { deletedAt: null };
  if (!isAdmin) {
    // PR #60: 2 値体系 (public / draft)
    where.OR = [
      { visibility: 'public' },
      { visibility: 'draft', createdBy: viewerUserId },
    ];
  }

  const knowledges = await prisma.knowledge.findMany({
    where,
    include: {
      creator: { select: { name: true } },
      updater: { select: { name: true } },
      knowledgeProjects: {
        select: {
          projectId: true,
          project: { select: { id: true, name: true, deletedAt: true } },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  return knowledges.map((k) => {
    const primary = k.knowledgeProjects[0];
    const primaryProjectId = primary?.projectId ?? null;
    const primaryProject = primary?.project ?? null;
    const isMember = primaryProjectId
      ? isAdmin || memberProjectIds.has(primaryProjectId)
      : isAdmin;
    const projectDeleted = primaryProject?.deletedAt != null;

    return {
      ...toKnowledgeDTO(k),
      primaryProjectId,
      projectName: isMember ? primaryProject?.name ?? null : null,
      projectDeleted: isAdmin ? projectDeleted : false,
      canAccessProject: isMember && !projectDeleted && primaryProjectId != null,
      linkedProjectCount: k.knowledgeProjects.length,
      updatedByName: isMember ? k.updater?.name ?? null : null,
      creatorName: isMember ? k.creator?.name : undefined,
    };
  });
}

/**
 * プロジェクトに紐づくナレッジのみを取得する (プロジェクト詳細「ナレッジ一覧」タブ用)。
 *
 * 既存 listKnowledge は全ナレッジ (visibility 制御のみ) を返すのに対し、
 * 本関数は knowledgeProjects 中間テーブル経由で projectId 一致のもののみ返す。
 *
 * 認可前提: 呼び出し側 (API ルート) で checkProjectPermission('knowledge:read') を通過済み。
 * サービス単体では追加の公開範囲制御はしない (プロジェクトメンバーは紐付くナレッジを
 * 公開範囲によらず全て見られる想定 = 一覧/全ナレッジの連動を保つ)。
 */
export async function listKnowledgeByProject(projectId: string): Promise<KnowledgeDTO[]> {
  const knowledges = await prisma.knowledge.findMany({
    where: {
      deletedAt: null,
      knowledgeProjects: { some: { projectId } },
    },
    include: {
      creator: { select: { name: true } },
      knowledgeProjects: { select: { projectId: true } },
    },
    orderBy: { createdAt: 'desc' },
  });
  return knowledges.map(toKnowledgeDTO);
}

export async function getKnowledge(knowledgeId: string): Promise<KnowledgeDTO | null> {
  const k = await prisma.knowledge.findFirst({
    where: { id: knowledgeId, deletedAt: null },
    include: {
      creator: { select: { name: true } },
      knowledgeProjects: { select: { projectId: true } },
    },
  });
  return k ? toKnowledgeDTO(k) : null;
}

export async function createKnowledge(
  input: CreateKnowledgeInput,
  userId: string,
): Promise<KnowledgeDTO> {
  const k = await prisma.knowledge.create({
    data: {
      title: input.title,
      knowledgeType: input.knowledgeType,
      background: input.background,
      content: input.content,
      result: input.result,
      conclusion: input.conclusion,
      recommendation: input.recommendation,
      reusability: input.reusability,
      techTags: (input.techTags || []) as Prisma.InputJsonValue,
      devMethod: input.devMethod,
      processTags: (input.processTags || []) as Prisma.InputJsonValue,
      visibility: input.visibility,
      createdBy: userId,
      updatedBy: userId,
      knowledgeProjects: input.projectIds?.length
        ? { create: input.projectIds.map((pid) => ({ projectId: pid })) }
        : undefined,
    },
    include: {
      creator: { select: { name: true } },
      knowledgeProjects: { select: { projectId: true } },
    },
  });

  return toKnowledgeDTO(k);
}

export async function updateKnowledge(
  knowledgeId: string,
  input: Partial<CreateKnowledgeInput>,
  userId: string,
): Promise<KnowledgeDTO> {
  const data: Prisma.KnowledgeUpdateInput = { updater: { connect: { id: userId } } };

  if (input.title !== undefined) data.title = input.title;
  if (input.knowledgeType !== undefined) data.knowledgeType = input.knowledgeType;
  if (input.background !== undefined) data.background = input.background;
  if (input.content !== undefined) data.content = input.content;
  if (input.result !== undefined) data.result = input.result;
  if (input.conclusion !== undefined) data.conclusion = input.conclusion;
  if (input.recommendation !== undefined) data.recommendation = input.recommendation;
  if (input.reusability !== undefined) data.reusability = input.reusability;
  if (input.techTags !== undefined) data.techTags = input.techTags as Prisma.InputJsonValue;
  if (input.devMethod !== undefined) data.devMethod = input.devMethod;
  if (input.processTags !== undefined) data.processTags = input.processTags as Prisma.InputJsonValue;
  if (input.visibility !== undefined) data.visibility = input.visibility;

  const k = await prisma.knowledge.update({
    where: { id: knowledgeId },
    data,
    include: {
      creator: { select: { name: true } },
      knowledgeProjects: { select: { projectId: true } },
    },
  });

  return toKnowledgeDTO(k);
}

export async function deleteKnowledge(knowledgeId: string, userId: string): Promise<void> {
  await prisma.knowledge.update({
    where: { id: knowledgeId },
    data: { deletedAt: new Date(), updater: { connect: { id: userId } } },
  });
}
