import { prisma } from '@/lib/db';
import type { Prisma } from '@/generated/prisma/client';
import type { UpdateProgressInput, WbsTemplateTask } from '@/lib/validators/task';
import type { z } from 'zod/v4';
import type { createTaskSchema, updateTaskSchema } from '@/lib/validators/task';

type CreateTaskInput = z.infer<typeof createTaskSchema>;
type UpdateTaskInput = z.infer<typeof updateTaskSchema>;

export type TaskDTO = {
  id: string;
  projectId: string;
  parentTaskId: string | null;
  parentTaskName?: string;
  type: string; // 'work_package' | 'activity'
  wbsNumber: string | null;
  name: string;
  description: string | null;
  assigneeId: string | null;
  assigneeName?: string;
  plannedStartDate: string | null;
  plannedEndDate: string | null;
  actualStartDate: string | null;
  actualEndDate: string | null;
  plannedEffort: number;
  priority: string | null;
  status: string;
  progressRate: number;
  isMilestone: boolean;
  notes: string | null;
  children?: TaskDTO[];
};

function toTaskDTO(t: {
  id: string;
  projectId: string;
  parentTaskId: string | null;
  parentTask?: { name: string } | null;
  type: string;
  wbsNumber: string | null;
  name: string;
  description: string | null;
  assigneeId: string | null;
  assignee?: { name: string } | null;
  plannedStartDate: Date | null;
  plannedEndDate: Date | null;
  actualStartDate: Date | null;
  actualEndDate: Date | null;
  plannedEffort: Prisma.Decimal;
  priority: string | null;
  status: string;
  progressRate: number;
  isMilestone: boolean;
  notes: string | null;
}): TaskDTO {
  return {
    id: t.id,
    projectId: t.projectId,
    parentTaskId: t.parentTaskId,
    parentTaskName: t.parentTask?.name,
    type: t.type,
    wbsNumber: t.wbsNumber,
    name: t.name,
    description: t.description,
    assigneeId: t.assigneeId,
    assigneeName: t.assignee?.name,
    plannedStartDate: t.plannedStartDate?.toISOString().split('T')[0] ?? null,
    plannedEndDate: t.plannedEndDate?.toISOString().split('T')[0] ?? null,
    actualStartDate: t.actualStartDate?.toISOString().split('T')[0] ?? null,
    actualEndDate: t.actualEndDate?.toISOString().split('T')[0] ?? null,
    plannedEffort: Number(t.plannedEffort),
    priority: t.priority,
    status: t.status,
    progressRate: t.progressRate,
    isMilestone: t.isMilestone,
    notes: t.notes,
  };
}

/**
 * プロジェクト内のタスク一覧をツリー構造で取得
 */
export async function listTasks(projectId: string): Promise<TaskDTO[]> {
  const tasks = await prisma.task.findMany({
    where: { projectId, deletedAt: null },
    include: { assignee: { select: { name: true } }, parentTask: { select: { name: true } } },
    orderBy: [{ plannedStartDate: 'asc' }, { plannedEndDate: 'asc' }, { createdAt: 'asc' }],
  });

  const dtos = tasks.map(toTaskDTO);
  return buildTree(dtos);
}

function buildTree(tasks: TaskDTO[]): TaskDTO[] {
  const map = new Map<string, TaskDTO>();
  const roots: TaskDTO[] = [];

  for (const task of tasks) {
    map.set(task.id, { ...task, children: [] });
  }

  for (const task of tasks) {
    const node = map.get(task.id)!;
    if (task.parentTaskId && map.has(task.parentTaskId)) {
      map.get(task.parentTaskId)!.children!.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots;
}

/**
 * フラットなタスク一覧（API 用）
 */
export async function listTasksFlat(projectId: string): Promise<TaskDTO[]> {
  const tasks = await prisma.task.findMany({
    where: { projectId, deletedAt: null },
    include: { assignee: { select: { name: true } }, parentTask: { select: { name: true } } },
    orderBy: [{ plannedStartDate: 'asc' }, { plannedEndDate: 'asc' }, { createdAt: 'asc' }],
  });
  return tasks.map(toTaskDTO);
}

export async function getTask(taskId: string): Promise<TaskDTO | null> {
  const task = await prisma.task.findFirst({
    where: { id: taskId, deletedAt: null },
    include: { assignee: { select: { name: true } }, parentTask: { select: { name: true } } },
  });
  return task ? toTaskDTO(task) : null;
}

export async function createTask(
  projectId: string,
  input: CreateTaskInput,
  userId: string,
): Promise<TaskDTO> {
  const isActivity = input.type === 'activity';

  const task = await prisma.task.create({
    data: {
      projectId,
      parentTaskId: input.parentTaskId,
      type: input.type,
      wbsNumber: input.wbsNumber,
      name: input.name,
      description: input.description,
      category: 'other',
      assigneeId: isActivity ? input.assigneeId : null,
      plannedStartDate: isActivity ? new Date(input.plannedStartDate) : null,
      plannedEndDate: isActivity ? new Date(input.plannedEndDate) : null,
      plannedEffort: isActivity ? input.plannedEffort : 0,
      priority: isActivity ? (input.priority || 'medium') : null,
      isMilestone: isActivity ? (input.isMilestone || false) : false,
      notes: input.notes,
      createdBy: userId,
      updatedBy: userId,
    },
    include: { assignee: { select: { name: true } }, parentTask: { select: { name: true } } },
  });

  // WP の場合は親の集計を更新
  if (task.parentTaskId) {
    await recalculateAncestors(task.parentTaskId);
  }

  return toTaskDTO(task);
}

export async function updateTask(
  taskId: string,
  input: UpdateTaskInput,
  userId: string,
): Promise<TaskDTO> {
  const data: Prisma.TaskUpdateInput = { updatedBy: userId };

  if (input.parentTaskId !== undefined) data.parentTask = input.parentTaskId ? { connect: { id: input.parentTaskId } } : { disconnect: true };
  if (input.wbsNumber !== undefined) data.wbsNumber = input.wbsNumber;
  if (input.name !== undefined) data.name = input.name;
  if (input.description !== undefined) data.description = input.description;
  if (input.assigneeId !== undefined) data.assignee = input.assigneeId ? { connect: { id: input.assigneeId } } : { disconnect: true };
  if (input.plannedStartDate !== undefined) data.plannedStartDate = input.plannedStartDate ? new Date(input.plannedStartDate) : null;
  if (input.plannedEndDate !== undefined) data.plannedEndDate = input.plannedEndDate ? new Date(input.plannedEndDate) : null;
  if (input.actualStartDate !== undefined) data.actualStartDate = input.actualStartDate ? new Date(input.actualStartDate) : null;
  if (input.actualEndDate !== undefined) data.actualEndDate = input.actualEndDate ? new Date(input.actualEndDate) : null;
  if (input.plannedEffort !== undefined) data.plannedEffort = input.plannedEffort;
  if (input.priority !== undefined) data.priority = input.priority;
  if (input.status !== undefined) data.status = input.status;
  if (input.progressRate !== undefined) data.progressRate = input.progressRate;
  if (input.isMilestone !== undefined) data.isMilestone = input.isMilestone;
  if (input.notes !== undefined) data.notes = input.notes;

  const task = await prisma.task.update({
    where: { id: taskId },
    data,
    include: { assignee: { select: { name: true } }, parentTask: { select: { name: true } } },
  });

  // 親ワークパッケージの集計を更新
  if (task.parentTaskId) {
    await recalculateAncestors(task.parentTaskId);
  }

  return toTaskDTO(task);
}

export async function deleteTask(taskId: string, userId: string): Promise<void> {
  const task = await prisma.task.update({
    where: { id: taskId },
    data: { deletedAt: new Date(), updatedBy: userId },
  });

  // 親ワークパッケージの集計を更新
  if (task.parentTaskId) {
    await recalculateAncestors(task.parentTaskId);
  }
}

/**
 * 複数タスクの担当者・優先度を一括更新
 */
export async function bulkUpdateTasks(
  projectId: string,
  taskIds: string[],
  updates: { assigneeId?: string | null; priority?: string },
  userId: string,
): Promise<number> {
  // 担当者がプロジェクトメンバーであることを検証
  if (updates.assigneeId) {
    const isMember = await prisma.projectMember.findFirst({
      where: { projectId, userId: updates.assigneeId },
    });
    if (!isMember) {
      throw new Error('ASSIGNEE_NOT_MEMBER');
    }
  }

  const result = await prisma.task.updateMany({
    where: {
      id: { in: taskIds },
      projectId,
      deletedAt: null,
      type: 'activity', // WPの担当者・優先度は直接変更しない
    },
    data: {
      ...(updates.assigneeId !== undefined ? { assigneeId: updates.assigneeId ?? null } : {}),
      ...(updates.priority !== undefined ? { priority: updates.priority } : {}),
      updatedBy: userId,
    },
  });

  return result.count;
}

export async function updateTaskProgress(
  taskId: string,
  input: UpdateProgressInput,
  userId: string,
): Promise<void> {
  // 進捗ログを記録
  await prisma.taskProgressLog.create({
    data: {
      taskId,
      updatedBy: userId,
      updateDate: new Date(),
      progressRate: input.progressRate,
      actualEffort: input.actualEffort,
      remainingEffort: input.remainingEffort,
      status: input.status,
      isDelayed: input.isDelayed || false,
      delayReason: input.delayReason,
      workMemo: input.workMemo,
      hasIssue: input.hasIssue || false,
      nextAction: input.nextAction,
      completedDate: input.status === 'completed' ? new Date() : undefined,
    },
  });

  // タスク本体の進捗率とステータスも更新
  const task = await prisma.task.update({
    where: { id: taskId },
    data: {
      progressRate: input.progressRate,
      status: input.status,
      updatedBy: userId,
    },
  });

  // 親ワークパッケージの集計を更新
  if (task.parentTaskId) {
    await recalculateAncestors(task.parentTaskId);
  }
}

/**
 * ワークパッケージの集計値（工数・進捗率・日付・ステータス）を子から再計算し更新する。
 * 祖先に向かって再帰的に伝播する。
 */
/** recalculateAncestors の公開ラッパー（インポート後の再集計用） */
async function recalculateAncestorsPublic(taskId: string): Promise<void> {
  return recalculateAncestors(taskId);
}

async function recalculateAncestors(taskId: string): Promise<void> {
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    include: {
      childTasks: {
        where: { deletedAt: null },
        select: {
          plannedEffort: true,
          progressRate: true,
          plannedStartDate: true,
          plannedEndDate: true,
          status: true,
          type: true,
        },
      },
    },
  });
  if (!task || task.type !== 'work_package') return;

  const children = task.childTasks;
  if (children.length === 0) {
    await prisma.task.update({
      where: { id: taskId },
      data: { plannedEffort: 0, progressRate: 0, plannedStartDate: null, plannedEndDate: null, status: 'not_started' },
    });
  } else {
    const totalEffort = children.reduce((sum, c) => sum + Number(c.plannedEffort), 0);

    // 加重平均進捗率（工数ベース）
    const weightedProgress = totalEffort > 0
      ? Math.round(children.reduce((sum, c) => sum + Number(c.plannedEffort) * c.progressRate, 0) / totalEffort)
      : 0;

    // 日付範囲（子の最小開始日〜最大終了日）
    const startDates = children.map((c) => c.plannedStartDate).filter(Boolean) as Date[];
    const endDates = children.map((c) => c.plannedEndDate).filter(Boolean) as Date[];
    const minStart = startDates.length > 0 ? new Date(Math.min(...startDates.map((d) => d.getTime()))) : null;
    const maxEnd = endDates.length > 0 ? new Date(Math.max(...endDates.map((d) => d.getTime()))) : null;

    // ステータス自動判定
    const statuses = children.map((c) => c.status);
    let wpStatus = 'not_started';
    if (statuses.every((s) => s === 'completed')) {
      wpStatus = 'completed';
    } else if (statuses.some((s) => s === 'in_progress' || s === 'completed')) {
      wpStatus = 'in_progress';
    } else if (statuses.some((s) => s === 'on_hold')) {
      wpStatus = 'on_hold';
    }

    await prisma.task.update({
      where: { id: taskId },
      data: {
        plannedEffort: totalEffort,
        progressRate: weightedProgress,
        plannedStartDate: minStart,
        plannedEndDate: maxEnd,
        status: wpStatus,
      },
    });
  }

  // 親があればさらに上に伝播
  if (task.parentTaskId) {
    await recalculateAncestors(task.parentTaskId);
  }
}

export type ProgressLogDTO = {
  id: string;
  updateDate: string;
  progressRate: number;
  actualEffort: number;
  status: string;
  isDelayed: boolean;
  delayReason: string | null;
  workMemo: string | null;
  updaterName: string;
  createdAt: string;
};

export async function getProgressLogs(taskId: string): Promise<ProgressLogDTO[]> {
  const logs = await prisma.taskProgressLog.findMany({
    where: { taskId },
    include: { updater: { select: { name: true } } },
    orderBy: { updateDate: 'desc' },
  });

  return logs.map((l) => ({
    id: l.id,
    updateDate: l.updateDate.toISOString().split('T')[0],
    progressRate: l.progressRate,
    actualEffort: Number(l.actualEffort),
    status: l.status,
    isDelayed: l.isDelayed,
    delayReason: l.delayReason,
    workMemo: l.workMemo,
    updaterName: l.updater.name,
    createdAt: l.createdAt.toISOString(),
  }));
}

/** CSV ヘッダー定義 */
const CSV_HEADERS = [
  'レベル', '種別', '名称', 'WBS番号', '予定開始日', '予定終了日',
  '見積工数', '優先度', 'マイルストーン', '備考',
] as const;

/** CSV フィールドをエスケープ（ダブルクォート） */
function escapeCsvField(value: string | null | undefined): string {
  if (value == null) return '';
  const s = String(value);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/** CSV 行をパース（ダブルクォート対応） */
export function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i++; // skip escaped quote
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        fields.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
  }
  fields.push(current);
  return fields;
}

/**
 * WBS テンプレートを CSV 形式でエクスポート。
 * 階層は「レベル」列（1始まり）と行の並び順で表現。
 */
export async function exportWbsTemplate(
  projectId: string,
  taskIds?: string[],
): Promise<string> {
  const where: Prisma.TaskWhereInput = { projectId, deletedAt: null };
  if (taskIds && taskIds.length > 0) {
    where.id = { in: taskIds };
  }

  const tasks = await prisma.task.findMany({
    where,
    include: { childTasks: { where: { deletedAt: null }, select: { id: true } } },
    orderBy: [{ plannedStartDate: 'asc' }, { createdAt: 'asc' }],
  });

  // ツリー構造を構築して深さ優先でフラット化
  const selectedIds = taskIds ? new Set(taskIds) : null;

  type FlatRow = { level: number; task: typeof tasks[0] };
  const rows: FlatRow[] = [];

  function walkTree(parentId: string | null, level: number) {
    const children = tasks.filter((t) => t.parentTaskId === parentId);
    for (const child of children) {
      if (selectedIds && !selectedIds.has(child.id)) continue;
      rows.push({ level, task: child });
      walkTree(child.id, level + 1);
    }
  }
  walkTree(null, 1);

  // 選択モードで親がない場合はルートとして追加
  if (selectedIds) {
    for (const t of tasks) {
      if (!rows.some((r) => r.task.id === t.id)) {
        rows.push({ level: 1, task: t });
      }
    }
  }

  // CSV 生成
  const csvLines = [CSV_HEADERS.join(',')];
  for (const { level, task: t } of rows) {
    const line = [
      String(level),
      t.type === 'work_package' ? 'WP' : 'ACT',
      escapeCsvField(t.name),
      escapeCsvField(t.wbsNumber),
      t.plannedStartDate?.toISOString().split('T')[0] ?? '',
      t.plannedEndDate?.toISOString().split('T')[0] ?? '',
      String(Number(t.plannedEffort)),
      t.priority ?? '',
      t.isMilestone ? '○' : '',
      escapeCsvField(t.notes),
    ].join(',');
    csvLines.push(line);
  }

  return csvLines.join('\n');
}

/**
 * CSV テキストを解析してインポート用データに変換。
 * レベル列と行順序から親子関係を復元する。
 */
export function parseCsvTemplate(csvText: string): WbsTemplateTask[] {
  const lines = csvText.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return []; // ヘッダーのみ

  // ヘッダー行をスキップ
  const dataLines = lines.slice(1);

  const tasks: WbsTemplateTask[] = [];
  // レベルごとの直近の tempId を管理するスタック
  const parentStack: string[] = []; // index = level-1

  for (let i = 0; i < dataLines.length; i++) {
    const fields = parseCsvLine(dataLines[i]);
    if (fields.length < 3) continue; // 最低限レベル・種別・名称が必要

    const level = parseInt(fields[0], 10);
    if (isNaN(level) || level < 1) continue;

    const typeRaw = fields[1]?.trim();
    const type = typeRaw === 'WP' ? 'work_package' : 'activity';
    const name = fields[2]?.trim();
    if (!name) continue;

    const tempId = `csv_${i + 1}`;

    // 親の決定: レベル N の親は直近のレベル N-1
    let parentTempId: string | null = null;
    if (level > 1 && parentStack.length >= level - 1) {
      parentTempId = parentStack[level - 2];
    }

    // スタック更新
    parentStack[level - 1] = tempId;
    // 深いレベルのスタックをクリア
    parentStack.length = level;

    tasks.push({
      tempId,
      parentTempId,
      type: type as 'work_package' | 'activity',
      wbsNumber: fields[3]?.trim() || null,
      name,
      plannedStartDate: fields[4]?.trim() || null,
      plannedEndDate: fields[5]?.trim() || null,
      plannedEffort: fields[6] ? parseFloat(fields[6]) || 0 : undefined,
      priority: (['low', 'medium', 'high'].includes(fields[7]?.trim()) ? fields[7].trim() : null) as 'low' | 'medium' | 'high' | null,
      isMilestone: fields[8]?.trim() === '○',
      notes: fields[9]?.trim() || null,
    });
  }

  return tasks;
}

/**
 * WBS テンプレートをインポート前にバリデーションする。
 * エラーがある場合は理由を配列で返す。
 */
export function validateWbsTemplate(templateTasks: WbsTemplateTask[]): string[] {
  const errors: string[] = [];
  const tempIds = new Set(templateTasks.map((t) => t.tempId));

  // tempId の重複チェック
  if (tempIds.size !== templateTasks.length) {
    errors.push('tempId が重複しています');
  }

  // 親参照の整合性チェック
  for (const t of templateTasks) {
    if (t.parentTempId && !tempIds.has(t.parentTempId)) {
      errors.push(`タスク "${t.name}" (${t.tempId}) の親 "${t.parentTempId}" がテンプレート内に存在しません`);
    }
  }

  // 循環参照チェック
  for (const t of templateTasks) {
    const visited = new Set<string>();
    let current: string | null | undefined = t.tempId;
    while (current) {
      if (visited.has(current)) {
        errors.push(`タスク "${t.name}" (${t.tempId}) に循環参照があります`);
        break;
      }
      visited.add(current);
      const parent = templateTasks.find((p) => p.tempId === current);
      current = parent?.parentTempId;
    }
  }

  // アクティビティの親がワークパッケージであるかチェック
  for (const t of templateTasks) {
    if (t.parentTempId) {
      const parent = templateTasks.find((p) => p.tempId === t.parentTempId);
      if (parent && parent.type !== 'work_package') {
        errors.push(`タスク "${t.name}" (${t.tempId}) の親 "${parent.name}" はワークパッケージではありません`);
      }
    }
  }

  return errors;
}

/**
 * WBS テンプレートをインポート。
 * tempId / parentTempId で階層構造を再構築する。
 * バリデーションエラー時は例外をスロー、DB操作はトランザクションでロールバック。
 */
export async function importWbsTemplate(
  projectId: string,
  templateTasks: WbsTemplateTask[],
  userId: string,
): Promise<number> {
  if (templateTasks.length === 0) return 0;

  // 事前バリデーション
  const validationErrors = validateWbsTemplate(templateTasks);
  if (validationErrors.length > 0) {
    throw new Error(`IMPORT_VALIDATION_ERROR:${validationErrors.join('; ')}`);
  }

  // 深度順にソート（parentTempId がないものを先に処理）
  const depthMap = new Map<string, number>();
  function calcDepth(tempId: string): number {
    if (depthMap.has(tempId)) return depthMap.get(tempId)!;
    const task = templateTasks.find((t) => t.tempId === tempId);
    if (!task?.parentTempId) { depthMap.set(tempId, 0); return 0; }
    const d = calcDepth(task.parentTempId) + 1;
    depthMap.set(tempId, d);
    return d;
  }
  templateTasks.forEach((t) => calcDepth(t.tempId));

  const sorted = [...templateTasks].sort(
    (a, b) => (depthMap.get(a.tempId) ?? 0) - (depthMap.get(b.tempId) ?? 0),
  );

  // トランザクションで一括作成（エラー時は自動ロールバック）
  const idMap = new Map<string, string>();

  await prisma.$transaction(async (tx) => {
    for (const t of sorted) {
      const parentId = t.parentTempId ? idMap.get(t.parentTempId) ?? null : null;
      const isActivity = t.type === 'activity';

      const created = await tx.task.create({
        data: {
          projectId,
          parentTaskId: parentId,
          type: t.type,
          wbsNumber: t.wbsNumber ?? null,
          name: t.name,
          description: t.description ?? null,
          category: 'other',
          assigneeId: isActivity ? (t.assigneeId ?? null) : null,
          plannedStartDate: isActivity && t.plannedStartDate ? new Date(t.plannedStartDate) : null,
          plannedEndDate: isActivity && t.plannedEndDate ? new Date(t.plannedEndDate) : null,
          plannedEffort: isActivity ? (t.plannedEffort ?? 0) : 0,
          priority: isActivity ? (t.priority ?? 'medium') : null,
          isMilestone: isActivity ? (t.isMilestone ?? false) : false,
          notes: t.notes ?? null,
          status: 'not_started',
          progressRate: 0,
          createdBy: userId,
          updatedBy: userId,
        },
      });

      idMap.set(t.tempId, created.id);
    }
  });

  // WP の集計を更新（トランザクション外 — 集計失敗はデータ破損にならないため）
  const wpIds = sorted.filter((t) => t.type === 'work_package').map((t) => idMap.get(t.tempId)!);
  for (const wpId of wpIds.reverse()) {
    await recalculateAncestorsPublic(wpId);
  }

  return idMap.size;
}

