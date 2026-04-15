import { prisma } from '@/lib/db';
import type { Prisma } from '@/generated/prisma/client';
import type { CreateTaskInput, UpdateProgressInput } from '@/lib/validators/task';

export type TaskDTO = {
  id: string;
  projectId: string;
  parentTaskId: string | null;
  wbsNumber: string | null;
  name: string;
  description: string | null;
  category: string;
  assigneeId: string;
  assigneeName?: string;
  plannedStartDate: string;
  plannedEndDate: string;
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
  wbsNumber: string | null;
  name: string;
  description: string | null;
  category: string;
  assigneeId: string;
  assignee?: { name: string };
  plannedStartDate: Date;
  plannedEndDate: Date;
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
    wbsNumber: t.wbsNumber,
    name: t.name,
    description: t.description,
    category: t.category,
    assigneeId: t.assigneeId,
    assigneeName: t.assignee?.name,
    plannedStartDate: t.plannedStartDate.toISOString().split('T')[0],
    plannedEndDate: t.plannedEndDate.toISOString().split('T')[0],
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
    include: { assignee: { select: { name: true } } },
    orderBy: [{ wbsNumber: 'asc' }, { createdAt: 'asc' }],
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
    include: { assignee: { select: { name: true } } },
    orderBy: [{ wbsNumber: 'asc' }, { createdAt: 'asc' }],
  });
  return tasks.map(toTaskDTO);
}

export async function getTask(taskId: string): Promise<TaskDTO | null> {
  const task = await prisma.task.findFirst({
    where: { id: taskId, deletedAt: null },
    include: { assignee: { select: { name: true } } },
  });
  return task ? toTaskDTO(task) : null;
}

export async function createTask(
  projectId: string,
  input: CreateTaskInput,
  userId: string,
): Promise<TaskDTO> {
  const task = await prisma.task.create({
    data: {
      projectId,
      parentTaskId: input.parentTaskId,
      wbsNumber: input.wbsNumber,
      name: input.name,
      description: input.description,
      category: input.category,
      assigneeId: input.assigneeId,
      plannedStartDate: new Date(input.plannedStartDate),
      plannedEndDate: new Date(input.plannedEndDate),
      plannedEffort: input.plannedEffort,
      priority: input.priority || 'medium',
      isMilestone: input.isMilestone || false,
      notes: input.notes,
      createdBy: userId,
      updatedBy: userId,
    },
    include: { assignee: { select: { name: true } } },
  });

  return toTaskDTO(task);
}

export async function updateTask(
  taskId: string,
  input: Partial<CreateTaskInput>,
  userId: string,
): Promise<TaskDTO> {
  const data: Prisma.TaskUpdateInput = { updatedBy: userId };

  if (input.parentTaskId !== undefined) data.parentTask = input.parentTaskId ? { connect: { id: input.parentTaskId } } : { disconnect: true };
  if (input.wbsNumber !== undefined) data.wbsNumber = input.wbsNumber;
  if (input.name !== undefined) data.name = input.name;
  if (input.description !== undefined) data.description = input.description;
  if (input.category !== undefined) data.category = input.category;
  if (input.assigneeId !== undefined) data.assignee = { connect: { id: input.assigneeId } };
  if (input.plannedStartDate !== undefined) data.plannedStartDate = new Date(input.plannedStartDate);
  if (input.plannedEndDate !== undefined) data.plannedEndDate = new Date(input.plannedEndDate);
  if (input.plannedEffort !== undefined) data.plannedEffort = input.plannedEffort;
  if (input.priority !== undefined) data.priority = input.priority;
  if (input.isMilestone !== undefined) data.isMilestone = input.isMilestone;
  if (input.notes !== undefined) data.notes = input.notes;

  const task = await prisma.task.update({
    where: { id: taskId },
    data,
    include: { assignee: { select: { name: true } } },
  });

  return toTaskDTO(task);
}

export async function deleteTask(taskId: string, userId: string): Promise<void> {
  await prisma.task.update({
    where: { id: taskId },
    data: { deletedAt: new Date(), updatedBy: userId },
  });
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
  await prisma.task.update({
    where: { id: taskId },
    data: {
      progressRate: input.progressRate,
      status: input.status,
      updatedBy: userId,
    },
  });
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
