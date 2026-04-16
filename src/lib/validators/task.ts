import { z } from 'zod/v4';

const dateRegex = /^\d{4}-\d{2}-\d{2}$/;

/**
 * ワークパッケージ作成スキーマ
 * - 担当者不要（集約ノード）
 * - 日付・工数は子から自動計算のため不要
 */
export const createWorkPackageSchema = z.object({
  type: z.literal('work_package'),
  parentTaskId: z.string().uuid().optional(),
  wbsNumber: z.string().max(50).optional(),
  name: z.string().min(1, 'ワークパッケージ名を入力してください').max(100),
  description: z.string().max(2000).optional(),
  notes: z.string().max(1000).optional(),
});

/**
 * アクティビティ作成スキーマ
 * - 担当者必須（実作業ノード）
 * - 日付・工数を直接入力
 */
export const createActivitySchema = z.object({
  type: z.literal('activity'),
  parentTaskId: z.string().uuid().optional(),
  wbsNumber: z.string().max(50).optional(),
  name: z.string().min(1, 'アクティビティ名を入力してください').max(100),
  description: z.string().max(2000).optional(),
  assigneeId: z.string().uuid('担当者を選択してください'),
  plannedStartDate: z.string().regex(dateRegex, '日付形式が不正です'),
  plannedEndDate: z.string().regex(dateRegex, '日付形式が不正です'),
  plannedEffort: z.number().positive('予定工数は正の数で入力してください'),
  priority: z.enum(['low', 'medium', 'high']).optional(),
  isMilestone: z.boolean().optional(),
  notes: z.string().max(1000).optional(),
});

/**
 * 統合作成スキーマ（type で分岐）
 */
export const createTaskSchema = z.discriminatedUnion('type', [
  createWorkPackageSchema,
  createActivitySchema,
]);

export const updateTaskSchema = z.object({
  type: z.enum(['work_package', 'activity']).optional(),
  parentTaskId: z.string().uuid().optional().nullable(),
  wbsNumber: z.string().max(50).optional(),
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(2000).optional().nullable(),
  assigneeId: z.string().uuid().optional().nullable(),
  plannedStartDate: z.string().regex(dateRegex).optional().nullable(),
  plannedEndDate: z.string().regex(dateRegex).optional().nullable(),
  actualStartDate: z.string().regex(dateRegex).optional().nullable(),
  actualEndDate: z.string().regex(dateRegex).optional().nullable(),
  plannedEffort: z.number().min(0).optional(),
  priority: z.enum(['low', 'medium', 'high']).optional(),
  status: z.enum(['not_started', 'in_progress', 'completed', 'on_hold']).optional(),
  progressRate: z.number().int().min(0).max(100).optional(),
  isMilestone: z.boolean().optional(),
  notes: z.string().max(1000).optional().nullable(),
});

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

export const bulkUpdateTaskSchema = z.object({
  taskIds: z.array(z.string().uuid()).min(1, '対象タスクを選択してください').max(100, '一括更新は100件までです'),
  assigneeId: z.string().uuid().optional().nullable(),
  priority: z.enum(['low', 'medium', 'high']).optional(),
});

/** WBS テンプレートのタスク1件分 */
const wbsTemplateTaskSchema = z.object({
  tempId: z.string().min(1),
  parentTempId: z.string().optional().nullable(),
  type: z.enum(['work_package', 'activity']),
  wbsNumber: z.string().max(50).optional().nullable(),
  name: z.string().min(1).max(100),
  description: z.string().max(2000).optional().nullable(),
  assigneeId: z.string().uuid().optional().nullable(),
  plannedStartDate: z.string().regex(dateRegex).optional().nullable(),
  plannedEndDate: z.string().regex(dateRegex).optional().nullable(),
  plannedEffort: z.number().min(0).optional(),
  priority: z.enum(['low', 'medium', 'high']).optional().nullable(),
  isMilestone: z.boolean().optional(),
  notes: z.string().max(1000).optional().nullable(),
});

export const wbsTemplateSchema = z.object({
  tasks: z.array(wbsTemplateTaskSchema).min(1, 'タスクが1件以上必要です').max(500, 'テンプレートは500件までです'),
});

export type WbsTemplateTask = z.infer<typeof wbsTemplateTaskSchema>;

export type CreateTaskInput = z.infer<typeof createTaskSchema>;
export type UpdateProgressInput = z.infer<typeof updateProgressSchema>;
export type BulkUpdateTaskInput = z.infer<typeof bulkUpdateTaskSchema>;
