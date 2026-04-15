import { z } from 'zod/v4';

export const createRetrospectiveSchema = z.object({
  conductedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  planSummary: z.string().min(1).max(2000),
  actualSummary: z.string().min(1).max(2000),
  goodPoints: z.string().min(1).max(3000),
  problems: z.string().min(1).max(3000),
  estimateGapFactors: z.string().max(3000).optional(),
  scheduleGapFactors: z.string().max(3000).optional(),
  qualityIssues: z.string().max(3000).optional(),
  riskResponseEvaluation: z.string().max(3000).optional(),
  improvements: z.string().min(1).max(3000),
  knowledgeToShare: z.string().max(3000).optional(),
});

export const updateRetrospectiveSchema = createRetrospectiveSchema.partial();

export const addCommentSchema = z.object({
  content: z.string().min(1, 'コメントを入力してください').max(2000),
});

export type CreateRetrospectiveInput = z.infer<typeof createRetrospectiveSchema>;
