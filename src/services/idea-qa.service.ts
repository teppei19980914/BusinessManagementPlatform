/**
 * 匿名 Q&A サービス (v1.5.0)
 *
 * セッション概念なし。プロジェクト単位で常時投稿可能な掲示板。
 *
 * 匿名化方針:
 *   - submittedBy は DB に保存するが、いかなる返り値にも含めない。
 *   - スレッドのクローズ (解消) は投稿者本人のみ可。
 *   - いいね (upvote) は重複防止のため userId を保存するが件数のみ公開。
 *
 * 埋もれたQ&A の掘り起こし:
 *   - sort: createdAt (デフォルト) / upvoteCount / lastAnsweredAt / unanswered
 *   - filter: all (デフォルト) / open / closed / unanswered
 *   - stale バッジ: open かつ 14 日以上回答なし
 */

import { prisma } from '@/lib/db';
import { generateEmbedding } from '@/services/embedding.service';
import type { CreateQaThreadInput, CreateQaAnswerInput, QaSortType, QaFilterType } from '@/lib/validators/idea-session';

/** スレッドが stale と判定される無回答日数 */
const STALE_DAYS = 14;

// ============================================================
// DTO 型
// ============================================================

export type QaAnswerDTO = {
  id: string;
  content: string;
  createdAt: string;
  updatedAt: string;
};

export type QaThreadDTO = {
  id: string;
  projectId: string;
  question: string;
  answerCount: number;
  lastAnsweredAt: string | null;
  upvoteCount: number;
  status: string;
  /** open かつ lastAnsweredAt が 14 日以上前 (または未回答で 14 日以上経過) */
  isStale: boolean;
  hasUpvoted: boolean;
  createdAt: string;
  updatedAt: string;
  answers: QaAnswerDTO[];
};

// ============================================================
// 内部ヘルパー
// ============================================================

function isStale(thread: { status: string; answerCount: number; lastAnsweredAt: Date | null; createdAt: Date }): boolean {
  if (thread.status === 'closed') return false;
  const threshold = new Date();
  threshold.setDate(threshold.getDate() - STALE_DAYS);
  if (thread.answerCount === 0) {
    return thread.createdAt < threshold;
  }
  return thread.lastAnsweredAt != null && thread.lastAnsweredAt < threshold;
}

function toAnswerDTO(a: { id: string; content: string; createdAt: Date; updatedAt: Date }): QaAnswerDTO {
  return {
    id: a.id,
    content: a.content,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
  };
}

function toThreadDTO(
  raw: {
    id: string;
    projectId: string;
    question: string;
    answerCount: number;
    lastAnsweredAt: Date | null;
    upvoteCount: number;
    status: string;
    createdAt: Date;
    updatedAt: Date;
    answers: { id: string; content: string; createdAt: Date; updatedAt: Date }[];
    upvotes: { userId: string }[];
  },
  userId: string,
): QaThreadDTO {
  return {
    id: raw.id,
    projectId: raw.projectId,
    question: raw.question,
    answerCount: raw.answerCount,
    lastAnsweredAt: raw.lastAnsweredAt?.toISOString() ?? null,
    upvoteCount: raw.upvoteCount,
    status: raw.status,
    isStale: isStale(raw),
    hasUpvoted: raw.upvotes.some((u) => u.userId === userId),
    createdAt: raw.createdAt.toISOString(),
    updatedAt: raw.updatedAt.toISOString(),
    answers: raw.answers.map(toAnswerDTO),
  };
}

function buildWhereFilter(projectId: string, tenantId: string, filter: QaFilterType, q?: string) {
  const base = {
    projectId,
    tenantId,
    deletedAt: null,
    ...(q ? { question: { contains: q, mode: 'insensitive' as const } } : {}),
  };
  switch (filter) {
    case 'open':
      return { ...base, status: 'open' };
    case 'closed':
      return { ...base, status: 'closed' };
    case 'unanswered':
      return { ...base, answerCount: 0 };
    default:
      return base;
  }
}

function buildOrderBy(sort: QaSortType) {
  switch (sort) {
    case 'upvoteCount':
      return [{ upvoteCount: 'desc' as const }, { createdAt: 'desc' as const }];
    case 'lastAnsweredAt':
      return [{ lastAnsweredAt: { sort: 'desc' as const, nulls: 'last' as const } }, { createdAt: 'desc' as const }];
    case 'unanswered':
      // 回答数昇順 → 投稿日降順 (未回答を先頭に)
      return [{ answerCount: 'asc' as const }, { createdAt: 'desc' as const }];
    default:
      return [{ createdAt: 'desc' as const }];
  }
}

// ============================================================
// Public API
// ============================================================

/**
 * スレッド一覧 (ソート・フィルタ付き)。
 */
export async function listQaThreads(
  projectId: string,
  userId: string,
  tenantId: string,
  sort: QaSortType = 'createdAt',
  filter: QaFilterType = 'all',
  q?: string,
): Promise<QaThreadDTO[]> {
  const rows = await prisma.ideaQaThread.findMany({
    where: buildWhereFilter(projectId, tenantId, filter, q),
    orderBy: buildOrderBy(sort),
    include: {
      answers: {
        where: { deletedAt: null },
        orderBy: { createdAt: 'asc' },
      },
      upvotes: { select: { userId: true } },
    },
  });

  return rows.map((r) => toThreadDTO(r, userId));
}

/**
 * スレッド単件取得。
 *
 * @throws {Error} 'NOT_FOUND'
 */
export async function getQaThread(
  threadId: string,
  userId: string,
  tenantId: string,
): Promise<QaThreadDTO> {
  const raw = await prisma.ideaQaThread.findFirst({
    where: { id: threadId, tenantId, deletedAt: null },
    include: {
      answers: { where: { deletedAt: null }, orderBy: { createdAt: 'asc' } },
      upvotes: { select: { userId: true } },
    },
  });
  if (!raw) throw new Error('NOT_FOUND');
  return toThreadDTO(raw, userId);
}

/**
 * スレッド作成。
 *
 * @throws {Error} なし (呼び出し元で権限チェック済み)
 */
export async function createQaThread(
  projectId: string,
  data: CreateQaThreadInput,
  userId: string,
  tenantId: string,
): Promise<QaThreadDTO> {
  const thread = await prisma.ideaQaThread.create({
    data: {
      tenantId,
      projectId,
      question: data.question,
      submittedBy: userId,
    },
    include: {
      answers: true,
      upvotes: { select: { userId: true } },
    },
  });
  return toThreadDTO(thread, userId);
}

/**
 * スレッドをクローズ (解消済みとしてマーク)。投稿者本人のみ。
 * 解消済み後も回答は投稿可能。
 *
 * @throws {Error} 'NOT_FOUND' | 'FORBIDDEN' | 'ALREADY_CLOSED'
 */
export async function closeQaThread(
  threadId: string,
  userId: string,
  tenantId: string,
): Promise<QaThreadDTO> {
  const raw = await prisma.ideaQaThread.findFirst({
    where: { id: threadId, tenantId, deletedAt: null },
    include: {
      answers: { where: { deletedAt: null }, orderBy: { createdAt: 'asc' } },
      upvotes: { select: { userId: true } },
    },
  });
  if (!raw) throw new Error('NOT_FOUND');
  if (raw.submittedBy !== userId) throw new Error('FORBIDDEN');
  if (raw.status === 'closed') throw new Error('ALREADY_CLOSED');

  await prisma.ideaQaThread.update({
    where: { id: threadId },
    data: { status: 'closed' },
  });
  raw.status = 'closed';

  // fire-and-forget: クローズ後に embedding 生成 (失敗してもクローズ自体は完了扱い)
  void (async () => {
    const parts = [raw.question, ...raw.answers.map((a) => a.content)];
    const text = parts.filter(Boolean).join('\n');
    const result = await generateEmbedding({
      text,
      featureUnit: 'idea-qa-embedding',
      tenantId,
      userId,
      inputType: 'document',
    });
    if (result.ok) {
      const vectorLiteral = `[${result.embedding.join(',')}]`;
      await prisma.$executeRaw`
        UPDATE "idea_qa_threads"
           SET "content_embedding" = ${vectorLiteral}::vector
         WHERE id = ${threadId}::uuid AND tenant_id = ${tenantId}::uuid
      `;
    }
  })();

  return toThreadDTO(raw, userId);
}

/**
 * 回答投稿。スレッドが存在していれば closed でも投稿可 (仕様)。
 * answerCount と lastAnsweredAt を非正規化更新する。
 *
 * @throws {Error} 'NOT_FOUND'
 */
export async function createAnswer(
  threadId: string,
  data: CreateQaAnswerInput,
  userId: string,
  tenantId: string,
): Promise<QaAnswerDTO> {
  const thread = await prisma.ideaQaThread.findFirst({
    where: { id: threadId, tenantId, deletedAt: null },
    select: { id: true },
  });
  if (!thread) throw new Error('NOT_FOUND');

  const now = new Date();
  const [answer] = await prisma.$transaction([
    prisma.ideaQaAnswer.create({
      data: {
        threadId,
        tenantId,
        submittedBy: userId,
        content: data.content,
      },
    }),
    prisma.ideaQaThread.update({
      where: { id: threadId },
      data: {
        answerCount: { increment: 1 },
        lastAnsweredAt: now,
      },
    }),
  ]);

  return toAnswerDTO(answer);
}

/**
 * いいね UPSERT。既にいいね済みの場合は削除 (トグル)。
 * upvoteCount を非正規化更新する。
 *
 * @throws {Error} 'NOT_FOUND'
 * @returns 更新後の upvoteCount
 */
export async function toggleUpvote(
  threadId: string,
  userId: string,
  tenantId: string,
): Promise<{ upvoteCount: number; hasUpvoted: boolean }> {
  const thread = await prisma.ideaQaThread.findFirst({
    where: { id: threadId, tenantId, deletedAt: null },
    select: { id: true, upvoteCount: true },
  });
  if (!thread) throw new Error('NOT_FOUND');

  const existing = await prisma.ideaQaUpvote.findUnique({
    where: { threadId_userId: { threadId, userId } },
  });

  let newCount: number;
  if (existing) {
    await prisma.$transaction([
      prisma.ideaQaUpvote.delete({ where: { threadId_userId: { threadId, userId } } }),
      prisma.ideaQaThread.update({
        where: { id: threadId },
        data: { upvoteCount: { decrement: 1 } },
      }),
    ]);
    newCount = Math.max(0, thread.upvoteCount - 1);
    return { upvoteCount: newCount, hasUpvoted: false };
  } else {
    await prisma.$transaction([
      prisma.ideaQaUpvote.create({ data: { threadId, tenantId, userId } }),
      prisma.ideaQaThread.update({
        where: { id: threadId },
        data: { upvoteCount: { increment: 1 } },
      }),
    ]);
    newCount = thread.upvoteCount + 1;
    return { upvoteCount: newCount, hasUpvoted: true };
  }
}

/**
 * スレッド論理削除。投稿者本人のみ。
 *
 * @throws {Error} 'NOT_FOUND' | 'FORBIDDEN'
 */
export async function deleteQaThread(
  threadId: string,
  userId: string,
  tenantId: string,
): Promise<void> {
  const row = await prisma.ideaQaThread.findFirst({
    where: { id: threadId, tenantId, deletedAt: null },
    select: { submittedBy: true },
  });
  if (!row) throw new Error('NOT_FOUND');
  if (row.submittedBy !== userId) throw new Error('FORBIDDEN');

  await prisma.ideaQaThread.update({
    where: { id: threadId },
    data: { deletedAt: new Date() },
  });
}

/**
 * 資産に紐づく Q&A スレッドの逆引き (IdeaAssetLink 経由)。
 * 返却は QaThreadDTO の簡易版 (answers は含まない)。
 */
export async function getQaThreadsByTarget(
  targetType: string,
  targetId: string,
  userId: string,
  tenantId: string,
): Promise<QaThreadDTO[]> {
  const links = await prisma.ideaAssetLink.findMany({
    where: { tenantId, targetType, targetId, sourceType: 'qa_thread' },
    select: { sourceId: true },
  });
  if (links.length === 0) return [];

  const threadIds = links.map((l) => l.sourceId);
  const rows = await prisma.ideaQaThread.findMany({
    where: { id: { in: threadIds }, tenantId, deletedAt: null },
    include: {
      answers: { where: { deletedAt: null }, orderBy: { createdAt: 'asc' } },
      upvotes: { select: { userId: true } },
    },
    orderBy: { createdAt: 'desc' },
  });
  return rows.map((r) => toThreadDTO(r, userId));
}
