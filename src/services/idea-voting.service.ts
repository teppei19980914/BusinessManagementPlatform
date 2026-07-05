/**
 * アイデア投票サービス (v1.5.0)
 *
 * ライブ投票 (kind='live') / 事前投票 (kind='pre') を統一管理する。
 * 投票方式: binary (二択必須理由) / dot (ドット投票・任意理由)。
 *
 * 匿名化方針:
 *   - submittedBy は DB に保存するが、いかなる返り値にも含めない。
 *   - アクティブ中: 自分の提出のみ返す + totalRespondents カウント。
 *   - クローズ後: 全提出を返す (isOwnSubmission フラグで本人識別)。
 *
 * セッションライフサイクル:
 *   active → closed
 *     - 手動: セッション作成者 (createdBy) のみ可
 *     - 自動: endsAt < now() の場合リクエスト到達時に lazy evaluation
 */

import { prisma } from '@/lib/db';
import { generateEmbedding } from '@/services/embedding.service';
import type { CreateVotingSessionInput, SubmitVoteInput } from '@/lib/validators/idea-session';
import type { IdeaVotingKind } from '@/lib/validators/idea-session';

// ============================================================
// DTO 型
// ============================================================

export type VotingOptionDTO = {
  id: string;
  label: string;
  displayOrder: number;
  /** クローズ後のみ: 各選択肢の総票数 */
  totalVotes?: number;
};

export type VotingAllocationDTO = {
  optionId: string;
  votes: number;
};

export type VotingSubmissionDTO = {
  id: string;
  reason: string | null;
  allocations: VotingAllocationDTO[];
  isOwnSubmission: boolean;
  createdAt: string;
};

export type VotingSessionDTO = {
  id: string;
  projectId: string;
  kind: string;
  voteType: string;
  title: string;
  description: string | null;
  votesPerMember: number | null;
  status: string;
  endsAt: string;
  closedAt: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  options: VotingOptionDTO[];
  /** アクティブ中: 自分の提出のみ (空の場合は未投票)。クローズ後: 全提出。 */
  submissions: VotingSubmissionDTO[];
  totalRespondents: number;
  /** 自分がすでに投票済みかどうか */
  hasSubmitted: boolean;
};

// ============================================================
// 内部: lazy auto-close
// ============================================================

async function maybeAutoClose(sessionId: string, endsAt: Date, tenantId: string): Promise<void> {
  if (endsAt > new Date()) return;
  await prisma.ideaVotingSession.updateMany({
    where: { id: sessionId, tenantId, status: 'active' },
    data: { status: 'closed', closedAt: new Date() },
  });
}

// ============================================================
// 内部: session → DTO
// ============================================================

type RawSession = Awaited<ReturnType<typeof fetchSessionRaw>>;

async function fetchSessionRaw(sessionId: string, tenantId: string) {
  return prisma.ideaVotingSession.findFirst({
    where: { id: sessionId, tenantId, deletedAt: null },
    include: {
      options: { orderBy: { displayOrder: 'asc' } },
      submissions: {
        where: { session: { deletedAt: null } },
        include: { allocations: true },
      },
    },
  });
}

function toDTO(raw: NonNullable<RawSession>, userId: string): VotingSessionDTO {
  const isClosed = raw.status === 'closed';
  const ownSub = raw.submissions.find((s) => s.submittedBy === userId);

  // Options: closed のみ totalVotes 集計
  const optionVotesMap = new Map<string, number>();
  if (isClosed) {
    for (const sub of raw.submissions) {
      for (const alloc of sub.allocations) {
        optionVotesMap.set(alloc.optionId, (optionVotesMap.get(alloc.optionId) ?? 0) + alloc.votes);
      }
    }
  }

  const options: VotingOptionDTO[] = raw.options.map((o) => ({
    id: o.id,
    label: o.label,
    displayOrder: o.displayOrder,
    ...(isClosed ? { totalVotes: optionVotesMap.get(o.id) ?? 0 } : {}),
  }));

  // Submissions 公開制御
  let submissions: VotingSubmissionDTO[];
  if (isClosed) {
    submissions = raw.submissions.map((s) => ({
      id: s.id,
      reason: s.reason,
      allocations: s.allocations.map((a) => ({ optionId: a.optionId, votes: a.votes })),
      isOwnSubmission: s.submittedBy === userId,
      createdAt: s.createdAt.toISOString(),
    }));
  } else {
    submissions = ownSub
      ? [
          {
            id: ownSub.id,
            reason: ownSub.reason,
            allocations: ownSub.allocations.map((a) => ({ optionId: a.optionId, votes: a.votes })),
            isOwnSubmission: true,
            createdAt: ownSub.createdAt.toISOString(),
          },
        ]
      : [];
  }

  return {
    id: raw.id,
    projectId: raw.projectId,
    kind: raw.kind,
    voteType: raw.voteType,
    title: raw.title,
    description: raw.description,
    votesPerMember: raw.votesPerMember,
    status: raw.status,
    endsAt: raw.endsAt.toISOString(),
    closedAt: raw.closedAt?.toISOString() ?? null,
    createdBy: raw.createdBy,
    createdAt: raw.createdAt.toISOString(),
    updatedAt: raw.updatedAt.toISOString(),
    options,
    submissions,
    totalRespondents: raw.submissions.length,
    hasSubmitted: ownSub != null,
  };
}

// ============================================================
// Public API
// ============================================================

/**
 * 投票セッション一覧。
 *
 * @throws {Error} 'PROJECT_NOT_FOUND' — プロジェクトが存在しない/他テナント
 */
export async function listVotingSessions(
  projectId: string,
  userId: string,
  tenantId: string,
  kind?: IdeaVotingKind,
  status?: string,
  q?: string,
): Promise<VotingSessionDTO[]> {
  const rows = await prisma.ideaVotingSession.findMany({
    where: {
      projectId,
      tenantId,
      deletedAt: null,
      ...(kind ? { kind } : {}),
      ...(status ? { status } : {}),
      ...(q ? { title: { contains: q, mode: 'insensitive' as const } } : {}),
    },
    include: {
      options: { orderBy: { displayOrder: 'asc' } },
      submissions: { include: { allocations: true } },
    },
    orderBy: { createdAt: 'desc' },
  });

  // lazy auto-close 対象を一括更新
  const needsClose = rows.filter((r) => r.status === 'active' && r.endsAt <= new Date());
  if (needsClose.length > 0) {
    await prisma.ideaVotingSession.updateMany({
      where: { tenantId, id: { in: needsClose.map((r) => r.id) }, status: 'active' },
      data: { status: 'closed', closedAt: new Date() },
    });
    for (const r of needsClose) {
      r.status = 'closed';
    }
  }

  return rows.map((r) => toDTO(r, userId));
}

/**
 * 投票セッション単件取得。
 *
 * @throws {Error} 'NOT_FOUND'
 */
export async function getVotingSession(
  sessionId: string,
  userId: string,
  tenantId: string,
): Promise<VotingSessionDTO> {
  const raw = await fetchSessionRaw(sessionId, tenantId);
  if (!raw) throw new Error('NOT_FOUND');

  await maybeAutoClose(raw.id, raw.endsAt, tenantId);
  if (raw.status === 'active' && raw.endsAt <= new Date()) {
    raw.status = 'closed';
  }

  return toDTO(raw, userId);
}

/**
 * 投票セッション作成。
 *
 * @throws {Error} 'INVALID_ENDS_AT' — 過去日時
 */
export async function createVotingSession(
  projectId: string,
  data: CreateVotingSessionInput,
  userId: string,
  tenantId: string,
): Promise<VotingSessionDTO> {
  const endsAt = new Date(data.endsAt);
  if (endsAt <= new Date()) throw new Error('INVALID_ENDS_AT');

  const session = await prisma.ideaVotingSession.create({
    data: {
      tenantId,
      projectId,
      kind: data.kind,
      voteType: data.voteType,
      title: data.title,
      description: data.description ?? null,
      votesPerMember: data.voteType === 'dot' ? data.votesPerMember : null,
      endsAt,
      createdBy: userId,
      updatedBy: userId,
      options: {
        create: data.options.map((o) => ({
          label: o.label,
          displayOrder: o.displayOrder,
        })),
      },
    },
    include: {
      options: { orderBy: { displayOrder: 'asc' } },
      submissions: { include: { allocations: true } },
    },
  });

  return toDTO(session, userId);
}

/**
 * 投票セッションを手動クローズ。作成者のみ実行可。
 *
 * @throws {Error} 'NOT_FOUND'
 * @throws {Error} 'FORBIDDEN' — 作成者以外
 * @throws {Error} 'ALREADY_CLOSED'
 */
export async function closeVotingSession(
  sessionId: string,
  userId: string,
  tenantId: string,
): Promise<VotingSessionDTO> {
  const raw = await fetchSessionRaw(sessionId, tenantId);
  if (!raw) throw new Error('NOT_FOUND');
  if (raw.createdBy !== userId) throw new Error('FORBIDDEN');
  if (raw.status === 'closed') throw new Error('ALREADY_CLOSED');

  await prisma.ideaVotingSession.update({
    where: { id: sessionId },
    data: { status: 'closed', closedBy: userId, closedAt: new Date(), updatedBy: userId },
  });
  raw.status = 'closed';

  // fire-and-forget: クローズ後に embedding 生成 (失敗してもクローズ自体は完了扱い)
  void (async () => {
    const optionLabels = raw.options.map((o) => o.label).join(' / ');
    const parts = [raw.title, raw.description ?? '', optionLabels];
    const text = parts.filter(Boolean).join('\n');
    const result = await generateEmbedding({
      text,
      featureUnit: 'idea-voting-embedding',
      tenantId,
      userId,
      inputType: 'document',
    });
    if (result.ok) {
      const vectorLiteral = `[${result.embedding.join(',')}]`;
      await prisma.$executeRaw`
        UPDATE "idea_voting_sessions"
           SET "content_embedding" = ${vectorLiteral}::vector
         WHERE id = ${sessionId}::uuid AND tenant_id = ${tenantId}::uuid
      `;
    }
  })();

  return toDTO(raw, userId);
}

/**
 * 投票提出 (UPSERT)。アクティブ中のみ受け付ける。
 *
 * binary: reason 必須チェックはバリデーター層で実施済み。
 * dot: allocations の合計 votes ≦ votesPerMember を検証する。
 *
 * @throws {Error} 'NOT_FOUND'
 * @throws {Error} 'SESSION_CLOSED'
 * @throws {Error} 'DOT_VOTES_EXCEEDED' — 合計票数超過
 */
export async function submitVote(
  sessionId: string,
  data: SubmitVoteInput,
  userId: string,
  tenantId: string,
): Promise<VotingSessionDTO> {
  const raw = await fetchSessionRaw(sessionId, tenantId);
  if (!raw) throw new Error('NOT_FOUND');

  // lazy auto-close 判定
  if (raw.status === 'active' && raw.endsAt <= new Date()) {
    await maybeAutoClose(raw.id, raw.endsAt, tenantId);
    raw.status = 'closed';
  }
  if (raw.status === 'closed') throw new Error('SESSION_CLOSED');

  if (raw.voteType === 'dot' && raw.votesPerMember != null) {
    const total = data.allocations.reduce((s, a) => s + a.votes, 0);
    if (total > raw.votesPerMember) throw new Error('DOT_VOTES_EXCEEDED');
  }

  // UPSERT: 既存の submission があれば削除して再作成 (allocations も cascade)
  await prisma.$transaction(async (tx) => {
    await tx.ideaVotingSubmission.deleteMany({
      where: { sessionId, tenantId, submittedBy: userId },
    });
    await tx.ideaVotingSubmission.create({
      data: {
        sessionId,
        tenantId,
        submittedBy: userId,
        reason: data.reason ?? null,
        allocations: {
          create: data.allocations.map((a) => ({
            optionId: a.optionId,
            votes: a.votes,
          })),
        },
      },
    });
  });

  // 最新状態を取得して返す
  const updated = await fetchSessionRaw(sessionId, tenantId);
  return toDTO(updated!, userId);
}

/**
 * 投票セッション論理削除。作成者のみ実行可。
 *
 * @throws {Error} 'NOT_FOUND'
 * @throws {Error} 'FORBIDDEN'
 */
export async function deleteVotingSession(
  sessionId: string,
  userId: string,
  tenantId: string,
): Promise<void> {
  const row = await prisma.ideaVotingSession.findFirst({
    where: { id: sessionId, tenantId, deletedAt: null },
    select: { createdBy: true },
  });
  if (!row) throw new Error('NOT_FOUND');
  if (row.createdBy !== userId) throw new Error('FORBIDDEN');

  await prisma.ideaVotingSession.update({
    where: { id: sessionId },
    data: { deletedAt: new Date(), updatedBy: userId },
  });
}
