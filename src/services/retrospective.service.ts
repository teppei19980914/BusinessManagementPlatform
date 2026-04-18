import { prisma } from '@/lib/db';
import type { CreateRetrospectiveInput } from '@/lib/validators/retrospective';

export type RetroDTO = {
  id: string;
  projectId: string;
  conductedDate: string;
  planSummary: string;
  actualSummary: string;
  goodPoints: string;
  problems: string;
  improvements: string;
  state: string;
  // PR #60: 公開範囲 (draft / public)
  visibility: string;
  createdAt: string;
  comments: { id: string; userName: string; content: string; createdAt: string }[];
};

/**
 * 「全振り返り」ビュー用 DTO。
 * 閲覧ユーザが紐づくプロジェクトの ProjectMember か否かで情報量を切り替える。
 * 非メンバー: projectName マスク / canAccessProject=false / コメント投稿者名マスク
 */
export type AllRetroDTO = Omit<RetroDTO, 'comments'> & {
  projectName: string | null;
  /** プロジェクトが論理削除済みか (admin のみ識別可、非 admin には false として秘匿) */
  projectDeleted: boolean;
  canAccessProject: boolean;
  // コメントは件数と本文のみ公開、投稿者氏名は非メンバー向けにマスク
  comments: { id: string; userName: string | null; content: string; createdAt: string }[];
  /** Req 4: 全振り返り画面で表示する追加フィールド (planSummary/actualSummary/improvements は既に RetroDTO 経由で含まれる) */
  updatedAt: string;
  createdByName: string | null;
  updatedByName: string | null;
};

/**
 * 全プロジェクトの振り返りを取得する (認可: ログインユーザなら誰でも可)。
 * 非メンバーの場合は projectName / コメント投稿者氏名をマスクする。
 */
export async function listAllRetrospectivesForViewer(
  viewerUserId: string,
  viewerSystemRole: string,
): Promise<AllRetroDTO[]> {
  const isAdmin = viewerSystemRole === 'admin';
  const memberships = isAdmin
    ? []
    : await prisma.projectMember.findMany({
      where: { userId: viewerUserId },
      select: { projectId: true },
    });
  const memberProjectIds = new Set(memberships.map((m) => m.projectId));

  // PR #60: 公開範囲制御 (admin 以外は public + 自身の draft のみ)
  const visibilityWhere = isAdmin
    ? {}
    : { OR: [{ visibility: 'public' }, { visibility: 'draft', createdBy: viewerUserId }] };

  const retros = await prisma.retrospective.findMany({
    where: { deletedAt: null, ...visibilityWhere },
    include: {
      comments: { orderBy: { createdAt: 'asc' } },
      project: { select: { id: true, name: true, deletedAt: true } },
    },
    orderBy: { conductedDate: 'desc' },
  });

  // コメント投稿者名 + createdBy / updatedBy を解決 (マスクは row 単位でメンバー判定)
  const userIds = [...new Set([
    ...retros.flatMap((r) => r.comments.map((c) => c.userId)),
    ...retros.map((r) => r.createdBy),
    ...retros.map((r) => r.updatedBy),
  ])];
  const users = userIds.length > 0
    ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } })
    : [];
  const userMap = new Map(users.map((u) => [u.id, u.name]));

  return retros.map((r) => {
    const isMember = isAdmin || memberProjectIds.has(r.projectId);
    const projectDeleted = r.project?.deletedAt != null;
    return {
      id: r.id,
      projectId: r.projectId,
      projectName: isMember ? r.project?.name ?? null : null,
      projectDeleted: isAdmin ? projectDeleted : false,
      canAccessProject: isMember && !projectDeleted,
      conductedDate: r.conductedDate.toISOString().split('T')[0],
      planSummary: r.planSummary,
      actualSummary: r.actualSummary,
      goodPoints: r.goodPoints,
      problems: r.problems,
      improvements: r.improvements,
      state: r.state,
      visibility: r.visibility,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
      createdByName: isMember ? userMap.get(r.createdBy) ?? null : null,
      updatedByName: isMember ? userMap.get(r.updatedBy) ?? null : null,
      comments: r.comments.map((c) => ({
        id: c.id,
        userName: isMember ? userMap.get(c.userId) ?? null : null,
        content: c.content,
        createdAt: c.createdAt.toISOString(),
      })),
    };
  });
}

export async function listRetrospectives(
  projectId: string,
  viewerUserId: string,
  viewerSystemRole: string,
): Promise<RetroDTO[]> {
  const isAdmin = viewerSystemRole === 'admin';
  // PR #60: 非 admin は public + 自身の draft のみ
  const visibilityWhere = isAdmin
    ? {}
    : { OR: [{ visibility: 'public' }, { visibility: 'draft', createdBy: viewerUserId }] };

  const retros = await prisma.retrospective.findMany({
    where: { projectId, deletedAt: null, ...visibilityWhere },
    include: {
      comments: {
        orderBy: { createdAt: 'asc' },
      },
    },
    orderBy: { conductedDate: 'desc' },
  });

  // コメントのユーザ名を取得
  const userIds = [...new Set(retros.flatMap((r) => r.comments.map((c) => c.userId)))];
  const users = userIds.length > 0
    ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } })
    : [];
  const userMap = new Map(users.map((u) => [u.id, u.name]));

  return retros.map((r) => ({
    id: r.id,
    projectId: r.projectId,
    conductedDate: r.conductedDate.toISOString().split('T')[0],
    planSummary: r.planSummary,
    actualSummary: r.actualSummary,
    goodPoints: r.goodPoints,
    problems: r.problems,
    improvements: r.improvements,
    state: r.state,
    visibility: r.visibility,
    createdAt: r.createdAt.toISOString(),
    comments: r.comments.map((c) => ({
      id: c.id,
      userName: userMap.get(c.userId) || '不明',
      content: c.content,
      createdAt: c.createdAt.toISOString(),
    })),
  }));
}

export async function createRetrospective(
  projectId: string,
  input: CreateRetrospectiveInput,
  userId: string,
): Promise<RetroDTO> {
  const r = await prisma.retrospective.create({
    data: {
      projectId,
      conductedDate: new Date(input.conductedDate),
      planSummary: input.planSummary,
      actualSummary: input.actualSummary,
      goodPoints: input.goodPoints,
      problems: input.problems,
      estimateGapFactors: input.estimateGapFactors,
      scheduleGapFactors: input.scheduleGapFactors,
      qualityIssues: input.qualityIssues,
      riskResponseEvaluation: input.riskResponseEvaluation,
      improvements: input.improvements,
      knowledgeToShare: input.knowledgeToShare,
      visibility: input.visibility ?? 'draft',
      createdBy: userId,
      updatedBy: userId,
    },
  });
  return {
    id: r.id,
    projectId: r.projectId,
    conductedDate: r.conductedDate.toISOString().split('T')[0],
    planSummary: r.planSummary,
    actualSummary: r.actualSummary,
    goodPoints: r.goodPoints,
    problems: r.problems,
    improvements: r.improvements,
    state: r.state,
    visibility: r.visibility,
    createdAt: r.createdAt.toISOString(),
    comments: [],
  };
}

export async function confirmRetrospective(retroId: string, userId: string): Promise<void> {
  await prisma.retrospective.update({
    where: { id: retroId },
    data: { state: 'confirmed', updatedBy: userId },
  });
}

/**
 * 振り返りを更新する (PR #56 Req 8/9 用)。
 * 編集可能フィールド: 実施日、計画総括、実績総括、良かった点、問題点、
 * 次回以前事項 (improvements)、その他の振り返り項目。
 * state は confirmRetrospective で別管理。
 */
export async function updateRetrospective(
  retroId: string,
  input: {
    conductedDate?: string;
    planSummary?: string;
    actualSummary?: string;
    goodPoints?: string;
    problems?: string;
    improvements?: string;
    estimateGapFactors?: string | null;
    scheduleGapFactors?: string | null;
    qualityIssues?: string | null;
    riskResponseEvaluation?: string | null;
    knowledgeToShare?: string | null;
    /** 'draft' | 'confirmed' 等。確定操作から同一 PATCH で受け付けるため許容 */
    state?: string;
    /** PR #60: 公開範囲 (draft / public) */
    visibility?: string;
  },
  userId: string,
): Promise<void> {
  const data: Record<string, unknown> = { updatedBy: userId };
  if (input.conductedDate !== undefined) data.conductedDate = new Date(input.conductedDate);
  if (input.planSummary !== undefined) data.planSummary = input.planSummary;
  if (input.actualSummary !== undefined) data.actualSummary = input.actualSummary;
  if (input.goodPoints !== undefined) data.goodPoints = input.goodPoints;
  if (input.problems !== undefined) data.problems = input.problems;
  if (input.improvements !== undefined) data.improvements = input.improvements;
  if (input.estimateGapFactors !== undefined) data.estimateGapFactors = input.estimateGapFactors;
  if (input.scheduleGapFactors !== undefined) data.scheduleGapFactors = input.scheduleGapFactors;
  if (input.qualityIssues !== undefined) data.qualityIssues = input.qualityIssues;
  if (input.riskResponseEvaluation !== undefined) data.riskResponseEvaluation = input.riskResponseEvaluation;
  if (input.knowledgeToShare !== undefined) data.knowledgeToShare = input.knowledgeToShare;
  if (input.state !== undefined) data.state = input.state;
  if (input.visibility !== undefined) data.visibility = input.visibility;

  await prisma.retrospective.update({ where: { id: retroId }, data });
}

/**
 * 振り返りを論理削除する (deletedAt をセット)。
 * 「全振り返り」「振り返り一覧」のどちらから呼んでも同一レコードに影響する。
 */
export async function deleteRetrospective(retroId: string, userId: string): Promise<void> {
  await prisma.retrospective.update({
    where: { id: retroId },
    data: { deletedAt: new Date(), updatedBy: userId },
  });
}

/** 単一振り返り取得 (権限チェック用) */
export async function getRetrospective(retroId: string): Promise<{ id: string; projectId: string } | null> {
  return prisma.retrospective.findFirst({
    where: { id: retroId, deletedAt: null },
    select: { id: true, projectId: true },
  });
}

export async function addComment(
  retroId: string,
  content: string,
  userId: string,
): Promise<void> {
  await prisma.retrospectiveComment.create({
    data: { retrospectiveId: retroId, userId, content },
  });
}
