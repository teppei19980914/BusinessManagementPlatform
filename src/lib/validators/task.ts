import { z } from 'zod/v4';

export const createTaskSchema = z.object({
  parentTaskId: z.string().uuid().optional(),
  wbsNumber: z.string().max(50).optional(),
  name: z.string().min(1, 'タスク名を入力してください').max(100),
  description: z.string().max(2000).optional(),
  category: z.enum([
    'requirements',
    'design',
    'development',
    'testing',
    'review',
    'management',
    'other',
  ]),
  assigneeId: z.string().uuid('担当者を選択してください'),
  plannedStartDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日付形式が不正です'),
  plannedEndDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日付形式が不正です'),
  plannedEffort: z.number().positive('予定工数は正の数で入力してください'),
  priority: z.enum(['low', 'medium', 'high']).optional(),
  isMilestone: z.boolean().optional(),
  notes: z.string().max(1000).optional(),
});

export const updateTaskSchema = createTaskSchema.partial();

export const updateProgressSchema = z.object({
  progressRate: z.number().int().min(0).max(100, '進捗率は0〜100で入力してください'),
  actualEffort: z.number().min(0, '実績工数は0以上で入力してください'),
  remainingEffort: z.number().min(0).optional(),
  status: z.enum(['not_started', 'in_progress', 'completed', 'on_hold']),
  isDelayed: z.boolean().optional(),
  delayReason: z.string().max(2000).optional(),
  workMemo: z.string().max(2000).optional(),
  hasIssue: z.boolean().optional(),
  nextAction: z.string().max(1000).optional(),
});

export type CreateTaskInput = z.infer<typeof createTaskSchema>;
export type UpdateProgressInput = z.infer<typeof updateProgressSchema>;
