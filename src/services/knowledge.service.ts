/**
 * ナレッジサービス (本プロダクトの中核資産)
 *
 * 役割:
 *   過去プロジェクトで得た「調査・検証・障害対応・教訓」等の知見を蓄積し、
 *   次案件の見積もり/計画に再利用できる形で提供する。本プロダクトのコンセプト
 *   「運営するほど次のプロジェクトがうまくいく」を実現する中心エンティティ。
 *
 * 設計判断:
 *   - 公開範囲 (visibility) は draft / public の 2 値 (PR #60 で project/company を public に統合)
 *     - draft  : 作成者 + admin のみ閲覧可
 *     - public : 全ログインユーザが閲覧可
 *   - 多対多のプロジェクト紐付け (knowledge_projects) を持つが、紐付けゼロでも独立ナレッジとして成立
 *   - タグは 3 種類: techTags (技術) / processTags (工程) / businessDomainTags (業務ドメイン)
 *     → 提案型サービス (suggestion.service.ts) で類似度マッチングに使用
 *   - 全文検索のため knowledges.title / content に pg_trgm GIN インデックスを設置済 (PR #65)
 *
 * 認可:
 *   呼び出し元 API ルート (src/app/api/knowledge/..., src/app/api/projects/[id]/knowledge/...)
 *   で checkPermission('knowledge:*') を実施済みの前提。本サービスは visibility による
 *   フィルタを行うクエリは含むが、ロール判定は行わない。
 *
 * 関連ドキュメント:
 *   - DESIGN.md §5 (テーブル定義: knowledges / knowledge_projects)
 *   - DESIGN.md §16 (全文検索設計 / pg_trgm)
 *   - DESIGN.md §23 (核心機能: 提案型サービス)
 *   - SPECIFICATION.md (ナレッジ一覧・編集・全ナレッジ画面)
 */

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
  businessDomainTags: string[];
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
  businessDomainTags: Prisma.JsonValue;
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
    businessDomainTags: (k.businessDomainTags as string[]) || [],
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
      businessDomainTags: (input.businessDomainTags || []) as Prisma.InputJsonValue,
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
  if (input.businessDomainTags !== undefined)
    data.businessDomainTags = input.businessDomainTags as Prisma.InputJsonValue;
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
  // PR #89: 紐づく Attachment も同時に論理削除 (孤児データ防止)
  const now = new Date();
  await prisma.$transaction([
    prisma.knowledge.update({
      where: { id: knowledgeId },
      data: { deletedAt: now, updater: { connect: { id: userId } } },
    }),
    prisma.attachment.updateMany({
      where: { entityType: 'knowledge', entityId: knowledgeId, deletedAt: null },
      data: { deletedAt: now },
    }),
  ]);
}
