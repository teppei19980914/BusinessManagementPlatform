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
  // ACT の実績工数 (人時)。担当者が実績入力。null = クリア。分析タブの工数効率/消化工数に使用。
  actualEffort: z.number().min(0, '実績工数は0以上で入力してください').optional().nullable(),
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

/**
 * 一括更新スキーマ。
 * 個別の「編集」「実績」フォームと同じフィールド集合を受け付ける。
 * - 編集系: assigneeId / priority / plannedStartDate / plannedEndDate / plannedEffort
 * - 実績系: status / progressRate / actualStartDate / actualEndDate
 * いずれも optional。クライアント側でユーザが「適用する」と選んだ項目のみを送る想定。
 * 1 件以上の更新項目が必須。
 */
// ADR-0035 準拠: クライアントは runChunkedBulk (chunkSize:100) で分割送信するため 1 リクエストは
// 最大 100 件。本 schema の max はチャンク未使用の巨大リクエストを弾く外側の安全弁 (2000 件)。
// route 層が追加の件数チェックを持つ場合はそちらより必ず大きく保つこと。
export const bulkUpdateTaskSchema = z
  .object({
    taskIds: z
      .array(z.string().uuid())
      .min(1, '対象タスクを選択してください')
      .max(2000, '一括更新のリクエストが大きすぎます'),
    // 編集系
    assigneeId: z.string().uuid().optional().nullable(),
    priority: z.enum(['low', 'medium', 'high']).optional(),
    plannedStartDate: z.string().regex(dateRegex).optional().nullable(),
    plannedEndDate: z.string().regex(dateRegex).optional().nullable(),
    plannedEffort: z.number().min(0).optional(),
    // 実績系
    status: z.enum(['not_started', 'in_progress', 'completed', 'on_hold']).optional(),
    progressRate: z.number().int().min(0).max(100).optional(),
    actualStartDate: z.string().regex(dateRegex).optional().nullable(),
    actualEndDate: z.string().regex(dateRegex).optional().nullable(),
    actualEffort: z.number().min(0, '実績工数は0以上で入力してください').optional().nullable(),
  })
  .refine(
    (v) =>
      v.assigneeId !== undefined
      || v.priority !== undefined
      || v.plannedStartDate !== undefined
      || v.plannedEndDate !== undefined
      || v.plannedEffort !== undefined
      || v.status !== undefined
      || v.progressRate !== undefined
      || v.actualStartDate !== undefined
      || v.actualEndDate !== undefined
      || v.actualEffort !== undefined,
    { message: '更新項目を1つ以上指定してください' },
  );

/**
 * 一括削除 (ADR-0035)。クライアントは K=100 件ずつチャンク送信するため通常 100 件以内。
 * 実効的な件数上限 (200 件 → 413) は route 層 (`TASK_BULK_DELETE_MAX`) が所有する
 * (ADR-0032 の checkCsvRowCount と同じく「schema は形式、route は件数ガード」の分担)。
 * 本 schema の max は、route に届く前に異常な巨大配列の UUID 検証で詰まらせないための
 * 外側の防波堤 (2000 件)。route の 200 件ガードより必ず大きく保つこと。
 */
export const bulkDeleteTaskSchema = z.object({
  taskIds: z
    .array(z.string().uuid())
    .min(1, '対象タスクを選択してください')
    .max(2000, '一括削除のリクエストが大きすぎます'),
});

// (T-19 で削除) wbsTemplateTaskSchema / wbsTemplateSchema / WbsTemplateTask は
// 旧 10 列テンプレートインポートで使用していた schema。sync-import (7 列) に一本化したため不要。

export type CreateTaskInput = z.infer<typeof createTaskSchema>;
export type UpdateProgressInput = z.infer<typeof updateProgressSchema>;
export type BulkUpdateTaskInput = z.infer<typeof bulkUpdateTaskSchema>;
export type BulkDeleteTaskInput = z.infer<typeof bulkDeleteTaskSchema>;
