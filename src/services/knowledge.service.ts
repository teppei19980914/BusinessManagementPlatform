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
 * 認可 (2026-04-24 改修):
 *   - 参照: 非 admin は visibility='public' のみ一覧表示、draft は他人のものは存在しない扱い。
 *           admin は 全一覧 + 個別参照とも draft 含め全件閲覧可。
 *   - 編集: **作成者 (createdBy) 本人のみ**。admin であっても他人のナレッジは編集不可。
 *   - 削除: 作成者本人 OR admin。admin は 全ナレッジ からの管理削除を想定。
 *   - 作成: 呼出元 API ルートで ProjectMember チェック済 (admin も非メンバーなら不可)。
 *           ただしプロジェクト紐付けなしの全社ナレッジ作成は POST /api/knowledge で
 *           認証ユーザ全員に許可する (個人資産的な用途)。
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

  // 2026-04-24: 非 admin は一覧に draft を一切含めない (自分の draft も除外)。
  // draft の個別参照は getKnowledge が作成者本人/admin のみ許可する。
  void userId; // 旧実装で OR 句の一部に使っていた参照を削除
  if (systemRole !== 'admin') {
    where.visibility = 'public';
  }

  if (params.knowledgeType) {
    where.knowledgeType = params.knowledgeType;
  }
  if (params.visibility) {
    where.visibility = params.visibility;
  }
  if (params.keyword) {
    where.OR = [
      { title: { contains: params.keyword, mode: 'insensitive' as const } },
      { content: { contains: params.keyword, mode: 'insensitive' as const } },
    ];
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
  /** PR #162: 横断ビュー一括 visibility 編集の対象判定。viewer が作成者本人なら true。 */
  viewerIsCreator: boolean;
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

  // 2026-04-25 (feat/account-lock-and-ui-consistency): admin であっても draft は
  // 「全○○」横断ビューには出さない (要件: 全○○ には公開範囲='public' のみ表示)。
  // admin が draft を管理削除したい場合はプロジェクト個別画面 (/projects/[id]/knowledge) から行う。
  // isAdmin は projectName / 作成者氏名のマスキング解除にのみ使う (フィルタには使わない)。
  const where: Prisma.KnowledgeWhereInput = { deletedAt: null, visibility: 'public' };

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
      // fix/cross-list-non-member-columns (PR #157, 2026-04-27): 横断「全ナレッジ」は visibility='public'
      // のものだけ表示しているため、作成者・更新者の氏名は公開してナレッジ共有を促進する。
      // projectName は機微情報扱いを維持 (上記 isMember gate)。
      updatedByName: k.updater?.name ?? null,
      creatorName: k.creator?.name,
      // PR #162: 横断ビュー一括 visibility 編集の対象判定。viewer が作成者本人なら true。
      viewerIsCreator: k.createdBy === viewerUserId,
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

/**
 * 単一ナレッジを取得する。
 *
 * 2026-04-24: draft は作成者 + admin のみ参照可。他人の draft は null を返す
 * (情報漏洩防止)。viewerUserId / viewerSystemRole を省略した内部呼び出しは
 * 公開範囲によらず生行を返す (cascade 削除等の運用確認用)。
 */
export async function getKnowledge(
  knowledgeId: string,
  viewerUserId?: string,
  viewerSystemRole?: string,
): Promise<KnowledgeDTO | null> {
  const k = await prisma.knowledge.findFirst({
    where: { id: knowledgeId, deletedAt: null },
    include: {
      creator: { select: { name: true } },
      knowledgeProjects: { select: { projectId: true } },
    },
  });
  if (!k) return null;

  if (viewerUserId === undefined) return toKnowledgeDTO(k);

  if (k.visibility === 'public') return toKnowledgeDTO(k);

  const isCreator = k.createdBy === viewerUserId;
  const isAdmin = viewerSystemRole === 'admin';
  if (isCreator || isAdmin) return toKnowledgeDTO(k);
  return null;
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

/**
 * ナレッジを更新する。
 *
 * 2026-04-24: **作成者 (createdBy) 本人のみ許可**。admin であっても他人のナレッジは
 * 編集不可 (管理業務は削除のみ)。
 *
 * @throws {Error} 'NOT_FOUND' — ナレッジが存在しない or 論理削除済み
 * @throws {Error} 'FORBIDDEN' — 呼出ユーザが作成者ではない
 */
export async function updateKnowledge(
  knowledgeId: string,
  input: Partial<CreateKnowledgeInput>,
  userId: string,
): Promise<KnowledgeDTO> {
  const existing = await prisma.knowledge.findFirst({
    where: { id: knowledgeId, deletedAt: null },
    select: { createdBy: true },
  });
  if (!existing) throw new Error('NOT_FOUND');
  if (existing.createdBy !== userId) throw new Error('FORBIDDEN');

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

/**
 * ナレッジを論理削除する。
 *
 * 2026-04-24: 作成者本人 OR admin のみ許可。admin は「全ナレッジ」画面からの
 * 管理削除を想定。
 *
 * @throws {Error} 'NOT_FOUND' — ナレッジが存在しない or 既に削除済み
 * @throws {Error} 'FORBIDDEN' — 作成者でなく admin でもない
 */
export async function deleteKnowledge(
  knowledgeId: string,
  userId: string,
  systemRole: string,
): Promise<void> {
  const existing = await prisma.knowledge.findFirst({
    where: { id: knowledgeId, deletedAt: null },
    select: { createdBy: true },
  });
  if (!existing) throw new Error('NOT_FOUND');
  const isCreator = existing.createdBy === userId;
  const isAdmin = systemRole === 'admin';
  if (!isCreator && !isAdmin) throw new Error('FORBIDDEN');

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

/**
 * 「全ナレッジ」横断ビューからの **visibility 一括更新** (PR #162 / Phase 2)。
 * PR #161 (Risk/Issue) と同じ二重防御: per-row createdBy 判定 + silent skip。
 * admin であっても他人のナレッジは更新しない。
 */
export async function bulkUpdateKnowledgeVisibilityFromCrossList(
  ids: string[],
  visibility: 'draft' | 'public',
  viewerUserId: string,
): Promise<{ updatedIds: string[]; skippedNotOwned: number; skippedNotFound: number }> {
  if (ids.length === 0) return { updatedIds: [], skippedNotOwned: 0, skippedNotFound: 0 };

  const targets = await prisma.knowledge.findMany({
    where: { id: { in: ids }, deletedAt: null },
    select: { id: true, createdBy: true },
  });
  const skippedNotFound = ids.length - targets.length;
  const ownedIds = targets.filter((t) => t.createdBy === viewerUserId).map((t) => t.id);
  const skippedNotOwned = targets.length - ownedIds.length;

  if (ownedIds.length === 0) {
    return { updatedIds: [], skippedNotOwned, skippedNotFound };
  }

  // updateMany は relation connect 構文を受け付けないため scalar `updatedBy` を直接セットする
  // (単発 updateKnowledge の `updater: { connect }` 経路とは別経路、§5.21 と同方針)
  await prisma.knowledge.updateMany({
    where: { id: { in: ownedIds } },
    data: { visibility, updatedBy: viewerUserId },
  });

  return { updatedIds: ownedIds, skippedNotOwned, skippedNotFound };
}
