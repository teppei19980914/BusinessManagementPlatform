import { prisma } from '@/lib/db';
import type { Prisma } from '@/generated/prisma/client';
import type { UpdateProgressInput } from '@/lib/validators/task';
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

/**
 * 既存プロジェクトの WBS を別プロジェクトに一括コピー。
 * - 階層構造を保持
 * - 担当者はリセット（null）
 * - 進捗率・ステータスは初期状態にリセット
 * - 日程・工数はそのままコピー
 */
export async function copyWbs(
  sourceProjectId: string,
  targetProjectId: string,
  userId: string,
): Promise<number> {
  const sourceTasks = await prisma.task.findMany({
    where: { projectId: sourceProjectId, deletedAt: null },
    orderBy: [{ plannedStartDate: 'asc' }, { plannedEndDate: 'asc' }, { createdAt: 'asc' }],
  });

  if (sourceTasks.length === 0) return 0;

  // 旧ID → 新ID のマッピング
  const idMap = new Map<string, string>();

  // 親がないもの → 親があるものの順で処理するため、ルートから先に作成
  const sorted = [...sourceTasks].sort((a, b) => {
    const depthA = getDepth(a.id, sourceTasks);
    const depthB = getDepth(b.id, sourceTasks);
    return depthA - depthB;
  });

  for (const src of sorted) {
    const newParentId = src.parentTaskId ? idMap.get(src.parentTaskId) ?? null : null;

    const created = await prisma.task.create({
      data: {
        projectId: targetProjectId,
        parentTaskId: newParentId,
        type: src.type,
        wbsNumber: src.wbsNumber,
        name: src.name,
        description: src.description,
        category: src.category,
        assigneeId: null, // 担当者はリセット
        plannedStartDate: src.plannedStartDate,
        plannedEndDate: src.plannedEndDate,
        plannedEffort: src.plannedEffort,
        priority: src.priority,
        status: 'not_started',
        progressRate: 0,
        isMilestone: src.isMilestone,
        notes: src.notes,
        createdBy: userId,
        updatedBy: userId,
      },
    });

    idMap.set(src.id, created.id);
  }

  return idMap.size;
}

function getDepth(taskId: string, tasks: { id: string; parentTaskId: string | null }[]): number {
  let depth = 0;
  let current = tasks.find((t) => t.id === taskId);
  while (current?.parentTaskId) {
    depth++;
    current = tasks.find((t) => t.id === current!.parentTaskId);
  }
  return depth;
}
