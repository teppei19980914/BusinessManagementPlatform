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
  // refactor/list-create-content-optional (2026-04-27 ユーザ要望 #6):
  // タイトルは必須維持、背景/内容/結果は任意化 (空文字許容)。
  background: z.string().max(MEDIUM_TEXT_MAX_LENGTH),
  content: z.string().max(KNOWLEDGE_CONTENT_MAX_LENGTH),
  result: z.string().max(LONG_TEXT_MAX_LENGTH),
  // feat/account-lock-and-ui-consistency 後 hotfix:
  // DB schema (Knowledge) で nullable な列は `.nullable().optional()` とする
  // (編集 dialog で空に戻すと null 送信されるため。詳細は DEVELOPER_GUIDE §5.12)
  conclusion: z.string().max(MEDIUM_TEXT_MAX_LENGTH).nullable().optional(),
  recommendation: z.string().max(MEDIUM_TEXT_MAX_LENGTH).nullable().optional(),
  reusability: z.enum(['low', 'medium', 'high']).nullable().optional(),
  techTags: z.array(z.string()).max(TAGS_MAX_COUNT).optional(),
  // PR-β / 項目 13 横展開: master-data.ts の DEV_METHODS と整合
  // (旧 'power_platform' は migration で 'low_code_no_code' に一括変換済)
  devMethod: z.enum(['scratch', 'low_code_no_code', 'package', 'other']).nullable().optional(),
  processTags: z.array(z.string()).max(TAGS_MAX_COUNT).optional(),
  // PR #65 Phase 2 (b): Project.businessDomainTags と対称化し提案精度を上げる
  businessDomainTags: z.array(z.string()).max(TAGS_MAX_COUNT).optional(),
  // PR #60: visibility を 2 値体系に統合 (project/company は migration で public に集約済)
  visibility: z.enum(['draft', 'public']),
  projectIds: z.array(z.string().uuid()).optional(),
});

export const updateKnowledgeSchema = createKnowledgeSchema.partial();

export type CreateKnowledgeInput = z.infer<typeof createKnowledgeSchema>;
