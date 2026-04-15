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
