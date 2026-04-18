import { z } from 'zod/v4';

export const createKnowledgeSchema = z.object({
  title: z.string().min(1, 'タイトルを入力してください').max(150),
  knowledgeType: z.enum([
    'research',
    'verification',
    'incident',
    'decision',
    'lesson',
    'best_practice',
    'other',
  ]),
  background: z.string().min(1, '背景を入力してください').max(2000),
  content: z.string().min(1, '内容を入力してください').max(5000),
  result: z.string().min(1, '結果を入力してください').max(3000),
  conclusion: z.string().max(2000).optional(),
  recommendation: z.string().max(2000).optional(),
  reusability: z.enum(['low', 'medium', 'high']).optional(),
  techTags: z.array(z.string()).max(50).optional(),
  devMethod: z.enum(['scratch', 'power_platform', 'package', 'other']).optional(),
  processTags: z.array(z.string()).max(50).optional(),
  // PR #60: visibility を 2 値体系に統合 (project/company は migration で public に集約済)
  visibility: z.enum(['draft', 'public']),
  projectIds: z.array(z.string().uuid()).optional(),
});

export const updateKnowledgeSchema = createKnowledgeSchema.partial();

export type CreateKnowledgeInput = z.infer<typeof createKnowledgeSchema>;
