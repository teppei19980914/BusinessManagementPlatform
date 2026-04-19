import { z } from 'zod/v4';

export const createProjectSchema = z.object({
  name: z.string().min(1, 'プロジェクト名を入力してください').max(100),
  customerName: z.string().min(1, '顧客名を入力してください').max(100),
  purpose: z.string().min(1, '目的を入力してください').max(2000),
  background: z.string().min(1, '背景を入力してください').max(2000),
  scope: z.string().min(1, 'スコープを入力してください').max(2000),
  outOfScope: z.string().max(2000).optional(),
  devMethod: z.enum(['scratch', 'power_platform', 'package', 'other']),
  businessDomainTags: z.array(z.string()).max(50).optional(),
  techStackTags: z.array(z.string()).max(50).optional(),
  // PR #65: 核心機能 (提案型サービス) のため工程タグを追加 (ナレッジと同じ粒度)
  processTags: z.array(z.string()).max(50).optional(),
  plannedStartDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日付形式が不正です'),
  plannedEndDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日付形式が不正です'),
  notes: z.string().max(2000).optional(),
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
