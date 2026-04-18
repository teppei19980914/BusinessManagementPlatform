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
  canAccessProject: boolean;
  // コメントは件数と本文のみ公開、投稿者氏名は非メンバー向けにマスク
  comments: { id: string; userName: string | null; content: string; createdAt: string }[];
};

/**
 * 全プロジェクトの振り返りを取得する (認可: ログインユーザなら誰でも可)。
 * 非メンバーの場合は projectName / コメント投稿者氏名をマスクする。
 */
export async function listAllRetrospectivesForViewer(
  viewerUserId: string,
): Promise<AllRetroDTO[]> {
  const memberships = await prisma.projectMember.findMany({
    where: { userId: viewerUserId },
    select: { projectId: true },
  });
  const memberProjectIds = new Set(memberships.map((m) => m.projectId));

  const retros = await prisma.retrospective.findMany({
    where: { deletedAt: null },
    include: {
      comments: { orderBy: { createdAt: 'asc' } },
      project: { select: { id: true, name: true } },
    },
    orderBy: { conductedDate: 'desc' },
  });

  // コメント投稿者名を解決 (メンバー判定に応じてマスクする)
  const userIds = [...new Set(retros.flatMap((r) => r.comments.map((c) => c.userId)))];
  const users = userIds.length > 0
    ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } })
    : [];
  const userMap = new Map(users.map((u) => [u.id, u.name]));

  return retros.map((r) => {
    const isMember = memberProjectIds.has(r.projectId);
    return {
      id: r.id,
      projectId: r.projectId,
      projectName: isMember ? r.project?.name ?? null : null,
      canAccessProject: isMember,
      conductedDate: r.conductedDate.toISOString().split('T')[0],
      planSummary: r.planSummary,
      actualSummary: r.actualSummary,
      goodPoints: r.goodPoints,
      problems: r.problems,
      improvements: r.improvements,
      state: r.state,
      createdAt: r.createdAt.toISOString(),
      comments: r.comments.map((c) => ({
        id: c.id,
        userName: isMember ? userMap.get(c.userId) ?? null : null,
        content: c.content,
        createdAt: c.createdAt.toISOString(),
      })),
    };
  });
}

export async function listRetrospectives(projectId: string): Promise<RetroDTO[]> {
  const retros = await prisma.retrospective.findMany({
    where: { projectId, deletedAt: null },
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

export async function addComment(
  retroId: string,
  content: string,
  userId: string,
): Promise<void> {
  await prisma.retrospectiveComment.create({
    data: { retrospectiveId: retroId, userId, content },
  });
}
