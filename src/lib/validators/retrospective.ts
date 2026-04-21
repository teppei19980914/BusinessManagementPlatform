import { z } from 'zod/v4';
import { MEDIUM_TEXT_MAX_LENGTH, LONG_TEXT_MAX_LENGTH } from '@/config';

export const createRetrospectiveSchema = z.object({
  conductedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  planSummary: z.string().min(1).max(MEDIUM_TEXT_MAX_LENGTH),
  actualSummary: z.string().min(1).max(MEDIUM_TEXT_MAX_LENGTH),
  goodPoints: z.string().min(1).max(LONG_TEXT_MAX_LENGTH),
  problems: z.string().min(1).max(LONG_TEXT_MAX_LENGTH),
  estimateGapFactors: z.string().max(LONG_TEXT_MAX_LENGTH).optional(),
  scheduleGapFactors: z.string().max(LONG_TEXT_MAX_LENGTH).optional(),
  qualityIssues: z.string().max(LONG_TEXT_MAX_LENGTH).optional(),
  riskResponseEvaluation: z.string().max(LONG_TEXT_MAX_LENGTH).optional(),
  improvements: z.string().min(1).max(LONG_TEXT_MAX_LENGTH),
  knowledgeToShare: z.string().max(LONG_TEXT_MAX_LENGTH).optional(),
  // PR #60: 公開範囲 (draft/public)
  visibility: z.enum(['draft', 'public']).optional(),
});

export const updateRetrospectiveSchema = createRetrospectiveSchema.partial();

export const addCommentSchema = z.object({
  content: z.string().min(1, 'コメントを入力してください').max(MEDIUM_TEXT_MAX_LENGTH),
});

export type CreateRetrospectiveInput = z.infer<typeof createRetrospectiveSchema>;
