import { z } from 'zod/v4';
import {
  NAME_MAX_LENGTH,
  MEDIUM_TEXT_MAX_LENGTH,
  TAGS_MAX_COUNT,
} from '@/config';

export const createProjectSchema = z.object({
  name: z.string().min(1, 'プロジェクト名を入力してください').max(NAME_MAX_LENGTH),
  // PR #111-2: 顧客は Customer マスタの選択式。UUID を受け取る。
  customerId: z.string().uuid({ message: '顧客を選択してください' }),
  purpose: z.string().min(1, '目的を入力してください').max(MEDIUM_TEXT_MAX_LENGTH),
  background: z.string().min(1, '背景を入力してください').max(MEDIUM_TEXT_MAX_LENGTH),
  scope: z.string().min(1, 'スコープを入力してください').max(MEDIUM_TEXT_MAX_LENGTH),
  // feat/account-lock-and-ui-consistency 後 hotfix: DB nullable 列は .nullable() 必須 (§5.12)
  outOfScope: z.string().max(MEDIUM_TEXT_MAX_LENGTH).nullable().optional(),
  devMethod: z.enum(['scratch', 'power_platform', 'package', 'other']),
  businessDomainTags: z.array(z.string()).max(TAGS_MAX_COUNT).optional(),
  techStackTags: z.array(z.string()).max(TAGS_MAX_COUNT).optional(),
  // PR #65: 核心機能 (提案型サービス) のため工程タグを追加 (ナレッジと同じ粒度)
  processTags: z.array(z.string()).max(TAGS_MAX_COUNT).optional(),
  plannedStartDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日付形式が不正です'),
  plannedEndDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日付形式が不正です'),
  notes: z.string().max(MEDIUM_TEXT_MAX_LENGTH).nullable().optional(),
});

export const updateProjectSchema = createProjectSchema.partial();

export const changeStatusSchema = z.object({
  status: z.enum([
    'planning',
    'estimating',
    'scheduling',
    'executing',
    'completed',
    'retrospected',
    'closed',
  ]),
});

export type CreateProjectSchemaInput = z.infer<typeof createProjectSchema>;
