import { z } from 'zod/v4';

export const createRiskSchema = z.object({
  type: z.enum(['risk', 'issue']),
  title: z.string().min(1, '件名を入力してください').max(100),
  content: z.string().min(1, '内容を入力してください').max(2000),
  cause: z.string().max(2000).optional(),
  impact: z.enum(['low', 'medium', 'high']),
  likelihood: z.enum(['low', 'medium', 'high']).optional(),
  // PR #63: 優先度は UI から撤去。将来 impact × likelihood から自動算出予定のため optional 化。
  // 指定なしの場合はサービス層で impact と同値にフォールバック。
  priority: z.enum(['low', 'medium', 'high']).optional(),
  responsePolicy: z.string().max(1000).optional(),
  responseDetail: z.string().max(2000).optional(),
  assigneeId: z.string().uuid().optional(),
  deadline: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  // PR #60: 公開範囲 (draft/public) と リスク脅威/好機分類
  visibility: z.enum(['draft', 'public']).optional(),
  riskNature: z.enum(['threat', 'opportunity']).optional(),
});

export const updateRiskSchema = createRiskSchema.partial().extend({
  state: z.enum(['open', 'in_progress', 'monitoring', 'resolved']).optional(),
  result: z.string().max(2000).optional(),
  lessonLearned: z.string().max(2000).optional(),
});

export type CreateRiskInput = z.infer<typeof createRiskSchema>;
