import { z } from 'zod/v4';

// ============================================================
// 共通定数
// ============================================================

export const IDEA_VOTING_KINDS = ['live', 'pre'] as const;
export const IDEA_VOTE_TYPES = ['binary', 'dot'] as const;
export const IDEA_SESSION_STATUSES = ['active', 'closed'] as const;
export const IDEA_QA_STATUSES = ['open', 'closed'] as const;

// IdeaAssetLink の source / target 種別
export const IDEA_LINK_SOURCE_TYPES = ['voting_session', 'whiteboard_session', 'qa_thread'] as const;
export const IDEA_LINK_TARGET_TYPES = ['task', 'risk', 'issue', 'knowledge', 'retrospective'] as const;

export type IdeaVotingKind = (typeof IDEA_VOTING_KINDS)[number];
export type IdeaVoteType = (typeof IDEA_VOTE_TYPES)[number];
export type IdeaLinkSourceType = (typeof IDEA_LINK_SOURCE_TYPES)[number];
export type IdeaLinkTargetType = (typeof IDEA_LINK_TARGET_TYPES)[number];

// Q&A ソート種別 (API クエリパラメータ)
export const QA_SORT_TYPES = ['createdAt', 'upvoteCount', 'lastAnsweredAt', 'unanswered'] as const;
export type QaSortType = (typeof QA_SORT_TYPES)[number];

// Q&A フィルタ種別 (API クエリパラメータ)
export const QA_FILTER_TYPES = ['all', 'open', 'closed', 'unanswered'] as const;
export type QaFilterType = (typeof QA_FILTER_TYPES)[number];

// ============================================================
// 投票セッション
// ============================================================

const ideaVotingOptionSchema = z.object({
  label: z.string().min(1).max(200),
  displayOrder: z.number().int().min(0),
});

export const createVotingSessionSchema = z
  .object({
    kind: z.enum(IDEA_VOTING_KINDS),
    voteType: z.enum(IDEA_VOTE_TYPES),
    title: z.string().min(1).max(200),
    description: z.string().max(2000).optional(),
    votesPerMember: z.number().int().min(1).max(10).optional(),
    endsAt: z.string().datetime({ offset: true }),
    options: z.array(ideaVotingOptionSchema).min(2).max(10),
  })
  .superRefine((val, ctx) => {
    if (val.voteType === 'dot' && val.votesPerMember == null) {
      ctx.addIssue({
        code: 'custom',
        path: ['votesPerMember'],
        message: 'ドット投票では votesPerMember は必須です',
      });
    }
    if (val.voteType === 'binary' && val.options.length !== 2) {
      ctx.addIssue({
        code: 'custom',
        path: ['options'],
        message: '二択投票の選択肢は 2 件です',
      });
    }
  });

export type CreateVotingSessionInput = z.infer<typeof createVotingSessionSchema>;

// ============================================================
// 投票提出 (UPSERT)
// ============================================================

const ideaVotingAllocationSchema = z.object({
  optionId: z.string().uuid(),
  votes: z.number().int().min(1),
});

export const submitVoteSchema = z
  .object({
    reason: z.string().max(1000).optional(),
    allocations: z.array(ideaVotingAllocationSchema).min(1),
  });

export type SubmitVoteInput = z.infer<typeof submitVoteSchema>;

// ============================================================
// ホワイトボードセッション
// ============================================================

export const createWhiteboardSessionSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  endsAt: z.string().datetime({ offset: true }),
});

export type CreateWhiteboardSessionInput = z.infer<typeof createWhiteboardSessionSchema>;

// ============================================================
// 付箋
// ============================================================

export const createWhiteboardNoteSchema = z.object({
  content: z.string().min(1).max(2000),
  category: z.string().max(50).optional(),
});

export const updateWhiteboardNoteSchema = z.object({
  content: z.string().min(1).max(2000).optional(),
  category: z.string().max(50).optional(),
});

export type CreateWhiteboardNoteInput = z.infer<typeof createWhiteboardNoteSchema>;
export type UpdateWhiteboardNoteInput = z.infer<typeof updateWhiteboardNoteSchema>;

// ============================================================
// 匿名 Q&A
// ============================================================

export const createQaThreadSchema = z.object({
  question: z.string().min(1).max(2000),
});

export type CreateQaThreadInput = z.infer<typeof createQaThreadSchema>;

export const createQaAnswerSchema = z.object({
  content: z.string().min(1).max(2000),
});

export type CreateQaAnswerInput = z.infer<typeof createQaAnswerSchema>;

// ============================================================
// アイデアアセットリンク
// ============================================================

export const createIdeaAssetLinkSchema = z.object({
  sourceType: z.enum(IDEA_LINK_SOURCE_TYPES),
  sourceId: z.string().uuid(),
  targetType: z.enum(IDEA_LINK_TARGET_TYPES),
  targetId: z.string().uuid(),
});

export const deleteIdeaAssetLinkSchema = z.object({
  sourceType: z.enum(IDEA_LINK_SOURCE_TYPES),
  sourceId: z.string().uuid(),
  targetType: z.enum(IDEA_LINK_TARGET_TYPES),
  targetId: z.string().uuid(),
});

export type CreateIdeaAssetLinkInput = z.infer<typeof createIdeaAssetLinkSchema>;
