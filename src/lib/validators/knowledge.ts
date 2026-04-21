import { z } from 'zod/v4';
import {
  TITLE_MAX_LENGTH,
  MEDIUM_TEXT_MAX_LENGTH,
  LONG_TEXT_MAX_LENGTH,
  KNOWLEDGE_CONTENT_MAX_LENGTH,
  TAGS_MAX_COUNT,
} from '@/config';

export const createKnowledgeSchema = z.object({
  title: z.string().min(1, 'タイトルを入力してください').max(TITLE_MAX_LENGTH),
  knowledgeType: z.enum([
    'research',
    'verification',
    'incident',
    'decision',
    'lesson',
    'best_practice',
    'other',
  ]),
  background: z.string().min(1, '背景を入力してください').max(MEDIUM_TEXT_MAX_LENGTH),
  content: z.string().min(1, '内容を入力してください').max(KNOWLEDGE_CONTENT_MAX_LENGTH),
  result: z.string().min(1, '結果を入力してください').max(LONG_TEXT_MAX_LENGTH),
  conclusion: z.string().max(MEDIUM_TEXT_MAX_LENGTH).optional(),
  recommendation: z.string().max(MEDIUM_TEXT_MAX_LENGTH).optional(),
  reusability: z.enum(['low', 'medium', 'high']).optional(),
  techTags: z.array(z.string()).max(TAGS_MAX_COUNT).optional(),
  devMethod: z.enum(['scratch', 'power_platform', 'package', 'other']).optional(),
  processTags: z.array(z.string()).max(TAGS_MAX_COUNT).optional(),
  // PR #65 Phase 2 (b): Project.businessDomainTags と対称化し提案精度を上げる
  businessDomainTags: z.array(z.string()).max(TAGS_MAX_COUNT).optional(),
  // PR #60: visibility を 2 値体系に統合 (project/company は migration で public に集約済)
  visibility: z.enum(['draft', 'public']),
  projectIds: z.array(z.string().uuid()).optional(),
});

export const updateKnowledgeSchema = createKnowledgeSchema.partial();

export type CreateKnowledgeInput = z.infer<typeof createKnowledgeSchema>;
