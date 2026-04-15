import { z } from 'zod/v4';

export const createRiskSchema = z.object({
  type: z.enum(['risk', 'issue']),
  title: z.string().min(1, '件名を入力してください').max(100),
  content: z.string().min(1, '内容を入力してください').max(2000),
  cause: z.string().max(2000).optional(),
  impact: z.enum(['low', 'medium', 'high']),
  likelihood: z.enum(['low', 'medium', 'high']).optional(),
  priority: z.enum(['low', 'medium', 'high']),
  responsePolicy: z.string().max(1000).optional(),
  responseDetail: z.string().max(2000).optional(),
  assigneeId: z.string().uuid().optional(),
  deadline: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export const updateRiskSchema = createRiskSchema.partial().extend({
  state: z.enum(['open', 'in_progress', 'monitoring', 'resolved']).optional(),
  result: z.string().max(2000).optional(),
  lessonLearned: z.string().max(2000).optional(),
});

export type CreateRiskInput = z.infer<typeof createRiskSchema>;
