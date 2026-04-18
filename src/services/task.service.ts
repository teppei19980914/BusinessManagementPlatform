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
    plannedStartDate: safeDate(t.plannedStartDate),
    plannedEndDate: safeDate(t.plannedEndDate),
    actualStartDate: safeDate(t.actualStartDate),
    actualEndDate: safeDate(t.actualEndDate),
    plannedEffort: Number(t.plannedEffort),
    priority: t.priority,
    status: t.status,
    progressRate: t.progressRate,
    isMilestone: t.isMilestone,
    notes: t.notes,
  };
}

/** Date を安全に YYYY-MM-DD 文字列に変換（無効な日付は null を返す） */
function safeDate(d: Date | null | undefined): string | null {
  if (!d) return null;
  const time = d.getTime();
  if (isNaN(time)) return null;
  return d.toISOString().split('T')[0];
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

export function buildTree(tasks: TaskDTO[]): TaskDTO[] {
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

/**
 * ツリー構造とフラット構造を同時に必要とする画面向け。
 * 1 回の DB クエリで両方のビューを生成する（listTasks + listTasksFlat の 2 クエリを集約）。
 * ツリー内のノードと flat のノードは別オブジェクトなので、双方を独立に変更しても影響しない。
 */
export async function listTasksWithTree(
  projectId: string,
): Promise<{ tree: TaskDTO[]; flat: TaskDTO[] }> {
  const tasks = await prisma.task.findMany({
    where: { projectId, deletedAt: null },
    include: { assignee: { select: { name: true } }, parentTask: { select: { name: true } } },
    orderBy: [{ plannedStartDate: 'asc' }, { plannedEndDate: 'asc' }, { createdAt: 'asc' }],
  });
  const flat = tasks.map(toTaskDTO);
  return { tree: buildTree(flat), flat };
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

/**
 * ステータスとの整合性に基づいて実績開始日・実績終了日を正規化する pure 関数。
 *
 * ビジネスルール（2026-04-17 ユーザ要件）:
 * - 実績開始日: ステータスが「未着手」ではない場合のみ保持。未着手なら null。
 *   （未着手の状態では「開始されている」とはみなされないため）
 * - 実績終了日: ステータスが「完了」の場合のみ保持。それ以外は null。
 *   （完了以外では「完了されている」とはみなされないため）
 *
 * @param status 最終ステータス（'not_started' | 'in_progress' | 'completed' | 'on_hold'）
 * @param actualStartDate ユーザまたは現在値の actualStartDate
 * @param actualEndDate ユーザまたは現在値の actualEndDate
 * @returns 正規化後の actualStartDate / actualEndDate
 */
/**
 * ステータスと進捗率の整合性ルール（2026-04-17 ユーザ要件）:
 *   ステータスが completed のときは進捗率を 100% に揃える。
 *
 * 理由: 完了ステータスなのに 50% のまま残っていると、親 WP の加重平均進捗が
 *   実態より低く算出されてしまう（=「完了したのに WP 進捗が 70%」のような不整合）。
 *   更新経路（updateTask / bulkUpdateTasks / updateTaskProgress）の集計ロジック
 *   実行前にこの関数を通すことで、ボトムアップ集計値の信頼性を担保する。
 *
 * completed 以外は呼び出し側から渡された値をそのまま返す（過剰な書き換えを避けるため）。
 * 必要に応じて not_started → 0 等の追加ルールは別途検討する。
 *
 * @param status 最終ステータス
 * @param progressRate 呼び出し側の進捗率（未指定時の fallback は呼び出し側で判断）
 * @returns 正規化後の進捗率
 */
export function normalizeProgressForStatus(
  status: string,
  progressRate: number | null | undefined,
): number | null | undefined {
  if (status === 'completed') return 100;
  return progressRate;
}

export function normalizeActualDatesForStatus(
  status: string,
  actualStartDate: Date | null | undefined,
  actualEndDate: Date | null | undefined,
): { actualStartDate: Date | null; actualEndDate: Date | null } {
  if (status === 'not_started') {
    // 未着手なら開始も終了も「起きていない」
    return { actualStartDate: null, actualEndDate: null };
  }
  if (status !== 'completed') {
    // 進行中 / 保留: 開始は起きたかもしれないが、完了していないので終了は null
    return {
      actualStartDate: actualStartDate ?? null,
      actualEndDate: null,
    };
  }
  // 完了: 両方保持
  return {
    actualStartDate: actualStartDate ?? null,
    actualEndDate: actualEndDate ?? null,
  };
}

export async function updateTask(
  taskId: string,
  input: UpdateTaskInput,
  userId: string,
): Promise<TaskDTO> {
  const data: Prisma.TaskUpdateInput = { updatedBy: userId };

  if (input.type !== undefined) data.type = input.type;
  if (input.parentTaskId !== undefined) data.parentTask = input.parentTaskId ? { connect: { id: input.parentTaskId } } : { disconnect: true };
  if (input.wbsNumber !== undefined) data.wbsNumber = input.wbsNumber;
  if (input.name !== undefined) data.name = input.name;
  if (input.description !== undefined) data.description = input.description;
  if (input.assigneeId !== undefined) data.assignee = input.assigneeId ? { connect: { id: input.assigneeId } } : { disconnect: true };
  if (input.plannedStartDate !== undefined) data.plannedStartDate = input.plannedStartDate ? new Date(input.plannedStartDate) : null;
  if (input.plannedEndDate !== undefined) data.plannedEndDate = input.plannedEndDate ? new Date(input.plannedEndDate) : null;
  if (input.plannedEffort !== undefined) data.plannedEffort = input.plannedEffort;
  if (input.priority !== undefined) data.priority = input.priority;
  if (input.progressRate !== undefined) data.progressRate = input.progressRate;
  if (input.isMilestone !== undefined) data.isMilestone = input.isMilestone;
  if (input.notes !== undefined) data.notes = input.notes;

  // status / actualStartDate / actualEndDate はステータス整合性ルールに基づき一括正規化する。
  // どれか 1 つでも変わる場合は現在値を読んで final 状態を確定し、ルール適用後に書き込む。
  if (input.status !== undefined || input.actualStartDate !== undefined || input.actualEndDate !== undefined) {
    const current = await prisma.task.findUnique({
      where: { id: taskId },
      select: { status: true, actualStartDate: true, actualEndDate: true },
    });
    if (!current) throw new Error('NOT_FOUND');

    const finalStatus = input.status ?? current.status;
    const providedStart
      = input.actualStartDate !== undefined
        ? (input.actualStartDate ? new Date(input.actualStartDate) : null)
        : current.actualStartDate;
    const providedEnd
      = input.actualEndDate !== undefined
        ? (input.actualEndDate ? new Date(input.actualEndDate) : null)
        : current.actualEndDate;

    const normalized = normalizeActualDatesForStatus(finalStatus, providedStart, providedEnd);
    data.status = finalStatus;
    data.actualStartDate = normalized.actualStartDate;
    data.actualEndDate = normalized.actualEndDate;

    // ステータス=完了 → 進捗率=100 の整合性ルール（集計前に適用）。
    // input.progressRate 指定があっても 100 に揃える（完了と矛盾する値を許容しない）。
    if (finalStatus === 'completed') {
      data.progressRate = 100;
    }
  }

  const task = await prisma.task.update({
    where: { id: taskId },
    data,
    include: { assignee: { select: { name: true } }, parentTask: { select: { name: true } } },
  });

  // 親ワークパッケージの集計を更新（ここは data.progressRate=100 書き込み後なので集計は正しい値を使う）
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
 * 複数アクティビティを一括更新する。
 *
 * サポート項目（個別フォームの「編集」「実績」に相当）:
 * - 編集系: assigneeId / priority / plannedStartDate / plannedEndDate / plannedEffort
 * - 実績系: status / progressRate / actualStartDate / actualEndDate
 *
 * 対象は `type: 'activity'` のみ（WP は子から自動集計されるため直接の値変更を避ける）。
 * 更新後は影響を受けた親 WP すべてに対して recalculateAncestors を実行し、
 * UI リロード時に正しい集計値が表示されるようにする。
 */
export async function bulkUpdateTasks(
  projectId: string,
  taskIds: string[],
  updates: {
    assigneeId?: string | null;
    priority?: string;
    plannedStartDate?: string | null;
    plannedEndDate?: string | null;
    plannedEffort?: number;
    status?: string;
    progressRate?: number;
    actualStartDate?: string | null;
    actualEndDate?: string | null;
  },
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

  // updateMany では関係スカラー（assigneeId 等）を直接セットするため UncheckedUpdateManyInput を使う
  const data: Prisma.TaskUncheckedUpdateManyInput = { updatedBy: userId };
  if (updates.assigneeId !== undefined) data.assigneeId = updates.assigneeId ?? null;
  if (updates.priority !== undefined) data.priority = updates.priority;
  if (updates.plannedStartDate !== undefined) {
    data.plannedStartDate = updates.plannedStartDate ? new Date(updates.plannedStartDate) : null;
  }
  if (updates.plannedEndDate !== undefined) {
    data.plannedEndDate = updates.plannedEndDate ? new Date(updates.plannedEndDate) : null;
  }
  if (updates.plannedEffort !== undefined) data.plannedEffort = updates.plannedEffort;
  if (updates.progressRate !== undefined) data.progressRate = updates.progressRate;

  // ステータス=完了 → 進捗率=100 の整合性ルール（集計前に適用）。
  // bulk では対象タスク全体が一括で completed になるため、progressRate を 100 に揃えても
  // 個別タスクの現行値を壊さない（どのみち全員 completed で統一される）。
  if (updates.status === 'completed') {
    data.progressRate = 100;
  }

  // status / actualStartDate / actualEndDate はステータス整合性ルールに基づき一括正規化する。
  // 一括更新では対象タスクごとの現行 actual 日付を見に行かず、bulk で指定された値のみを
  // 新しいステータスに照らしてクリア/保持する方針（バッチ処理の単純性と性能を優先）。
  if (updates.status !== undefined) {
    // ステータスが指定された場合: 新ステータスに応じて actual 日付を正規化
    const providedStart
      = updates.actualStartDate !== undefined
        ? (updates.actualStartDate ? new Date(updates.actualStartDate) : null)
        : null; // bulk では「未指定 = null」と同等に扱う
    const providedEnd
      = updates.actualEndDate !== undefined
        ? (updates.actualEndDate ? new Date(updates.actualEndDate) : null)
        : null;
    const normalized = normalizeActualDatesForStatus(updates.status, providedStart, providedEnd);
    data.status = updates.status;
    // actual 日付が bulk で指定されている、またはステータスに伴い強制クリアが必要な場合は書き込む
    if (updates.actualStartDate !== undefined || updates.status === 'not_started') {
      data.actualStartDate = normalized.actualStartDate;
    }
    if (
      updates.actualEndDate !== undefined
      || updates.status === 'not_started'
      || updates.status === 'in_progress'
      || updates.status === 'on_hold'
    ) {
      data.actualEndDate = normalized.actualEndDate;
    }
  } else {
    // ステータスが指定されない場合: bulk の actual 日付指定のみ素直に反映（サーバ側では
    // 各タスクの現在ステータスを個別取得しないため、不整合は呼び出し側の責任とする）
    if (updates.actualStartDate !== undefined) {
      data.actualStartDate = updates.actualStartDate ? new Date(updates.actualStartDate) : null;
    }
    if (updates.actualEndDate !== undefined) {
      data.actualEndDate = updates.actualEndDate ? new Date(updates.actualEndDate) : null;
    }
  }

  const result = await prisma.task.updateMany({
    where: {
      id: { in: taskIds },
      projectId,
      deletedAt: null,
      type: 'activity', // WP は対象外（集計値は子から自動算出）
    },
    data,
  });

  // 親 WP の集計を再計算する必要があるかを判定。
  // plannedEffort / planned/actual 日付 / status / progressRate / assigneeId のいずれかを
  // 変更した場合は再計算対象。assigneeId は PR #45 以降、親 WP の担当者集約にも影響するため
  // 再集計トリガに含める（priority は集計値に影響しないのでスキップ）。
  const needsRecalc
    = updates.plannedEffort !== undefined
    || updates.plannedStartDate !== undefined
    || updates.plannedEndDate !== undefined
    || updates.actualStartDate !== undefined
    || updates.actualEndDate !== undefined
    || updates.status !== undefined
    || updates.assigneeId !== undefined
    || updates.progressRate !== undefined;

  if (needsRecalc && result.count > 0) {
    const affected = await prisma.task.findMany({
      where: { id: { in: taskIds }, projectId, deletedAt: null, type: 'activity' },
      select: { parentTaskId: true },
    });
    const uniqueParentIds = [
      ...new Set(affected.map((t) => t.parentTaskId).filter((id): id is string => id != null)),
    ];
    for (const parentId of uniqueParentIds) {
      await recalculateAncestors(parentId);
    }
  }

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

  // ステータス変更に伴う actual 日付の正規化のため現行値を取得
  const current = await prisma.task.findUnique({
    where: { id: taskId },
    select: { actualStartDate: true, actualEndDate: true },
  });
  const normalized = normalizeActualDatesForStatus(
    input.status,
    current?.actualStartDate ?? null,
    current?.actualEndDate ?? null,
  );

  // ステータス=完了 → 進捗率=100 の整合性ルール（集計前に適用）
  const normalizedProgress = input.status === 'completed' ? 100 : input.progressRate;

  // タスク本体の進捗率・ステータス・実績日付を更新
  const task = await prisma.task.update({
    where: { id: taskId },
    data: {
      progressRate: normalizedProgress,
      status: input.status,
      actualStartDate: normalized.actualStartDate,
      actualEndDate: normalized.actualEndDate,
      updatedBy: userId,
    },
  });

  // 親ワークパッケージの集計を更新（完了時は 100% 書き込み後なので加重平均が正しく計算される）
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

/**
 * プロジェクト内の全 WP 集計値を再計算する修復ツール。
 *
 * 動機 (2026-04-18):
 *   PR #45 で導入した「子の担当者が全員同一なら親 WP も同じ担当者」のボトムアップ集約は、
 *   ACT 更新をトリガに走る recalculateAncestors 経由でしか動かないため、
 *   PR #45 より前に作成・インポートされた既存 WP は null のまま残る。
 *   また、異なるサブツリーに対して個別 ACT を更新しても、更新した枝の祖先しか
 *   再計算されないため、未更新の枝の WP は古い集計値のまま。
 *
 *   このバックフィル関数はプロジェクト内の全 WP を深度降順（深い WP を先）で
 *   再集計し、データを最新ロジックに揃える。
 *
 * パフォーマンス (2026-04-18 改善):
 *   - A 案: recalculateWpOnly を使い、深度順ループで祖先伝播を省略
 *     → O(N × depth) → O(N) に削減
 *   - C 案: 集計値が現在値と一致する WP は update を skip
 *     → 2 回目以降の実行および部分的に最新のデータで DB 書込を大幅削減
 *
 * @returns { total: 走査した WP 数, updated: 実際に update された WP 数 }
 */
export async function recalculateAllProjectWps(
  projectId: string,
): Promise<{ total: number; updated: number }> {
  const wps = await prisma.task.findMany({
    where: { projectId, type: 'work_package', deletedAt: null },
    select: { id: true, parentTaskId: true },
  });
  if (wps.length === 0) return { total: 0, updated: 0 };

  // 深度マップを作成: 祖先チェーンの長さ = その WP の深度
  const byId = new Map(wps.map((w) => [w.id, w]));
  const depthOf = (id: string): number => {
    let d = 0;
    let cur: string | null | undefined = id;
    // 最大 100 階層を上限に設定（循環参照の防波堤）
    for (let i = 0; i < 100 && cur; i++) {
      const w = byId.get(cur);
      if (!w) break;
      if (w.parentTaskId === null) break;
      cur = w.parentTaskId;
      d++;
    }
    return d;
  };

  const sorted = wps
    .map((w) => ({ id: w.id, depth: depthOf(w.id) }))
    .sort((a, b) => b.depth - a.depth);

  let updated = 0;
  for (const w of sorted) {
    // A 案: 深度降順で処理するため、子 WP は既に最新。祖先への伝播は不要。
    //        recalculateWpOnly は上方伝播せず、自身のみ更新（+ C 案で一致時スキップ）
    const didUpdate = await recalculateWpOnly(w.id);
    if (didUpdate) updated++;
  }

  return { total: sorted.length, updated };
}

/**
 * 子タスクの集合から WP の集計値を算出する pure 関数。
 * DB 非依存なので単体テスト可能。
 *
 * 実績日付（actualStartDate / actualEndDate）も予定日付と同じロジックで集計する：
 * 子の有効な actual 日付のうち最小/最大を採用、すべて null なら null。
 */
export type WpAggregationChild = {
  plannedEffort: Prisma.Decimal;
  progressRate: number;
  plannedStartDate: Date | null;
  plannedEndDate: Date | null;
  actualStartDate: Date | null;
  actualEndDate: Date | null;
  status: string;
  assigneeId: string | null;
};

export type WpAggregationResult = {
  plannedEffort: number;
  progressRate: number;
  plannedStartDate: Date | null;
  plannedEndDate: Date | null;
  actualStartDate: Date | null;
  actualEndDate: Date | null;
  status: string;
  /**
   * 子の担当者がすべて同一（非 null）なら親もその担当者を共有する。
   * 混在または全て未アサインなら null（担当者なし）。
   * 再帰的 recalculateAncestors により、孫以降の変更もボトムアップで伝播する。
   */
  assigneeId: string | null;
};

export function aggregateWpFromChildren(children: WpAggregationChild[]): WpAggregationResult {
  if (children.length === 0) {
    return {
      plannedEffort: 0,
      progressRate: 0,
      plannedStartDate: null,
      plannedEndDate: null,
      actualStartDate: null,
      actualEndDate: null,
      status: 'not_started',
      assigneeId: null,
    };
  }

  const totalEffort = children.reduce((sum, c) => sum + Number(c.plannedEffort), 0);

  // 加重平均進捗率（工数ベース）
  const weightedProgress = totalEffort > 0
    ? Math.round(children.reduce((sum, c) => sum + Number(c.plannedEffort) * c.progressRate, 0) / totalEffort)
    : 0;

  // 有効な日付のみを抽出して min/max を取る共通ヘルパー
  const pickDates = (pick: (c: WpAggregationChild) => Date | null): Date[] =>
    children.map(pick).filter((d): d is Date => d != null && !isNaN(d.getTime()));
  const minDate = (dates: Date[]): Date | null =>
    dates.length > 0 ? new Date(Math.min(...dates.map((d) => d.getTime()))) : null;
  const maxDate = (dates: Date[]): Date | null =>
    dates.length > 0 ? new Date(Math.max(...dates.map((d) => d.getTime()))) : null;

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

  // 実績日付は予定と同じ min/max ロジックで集計した上で、ステータス整合性ルール（PR #39）を
  // 親 WP にも適用する。WP のステータスは子から導出されるため:
  //   - wpStatus='not_started': 子がまだ始まっていない → 実績開始/終了とも null
  //   - wpStatus='in_progress' / 'on_hold': WP はまだ完了していない → 実績終了日は null
  //   - wpStatus='completed': 両方保持
  // これにより「子の一部が未着手なのに親 WP に実績終了日が表示される」問題を防ぐ。
  const rawActualStart = minDate(pickDates((c) => c.actualStartDate));
  const rawActualEnd = maxDate(pickDates((c) => c.actualEndDate));
  const normalized = normalizeActualDatesForStatus(wpStatus, rawActualStart, rawActualEnd);

  // 担当者集約: 直接の子の assigneeId がすべて同一 (非 null) なら親もその assignee を共有。
  // 子 WP は既に自身の recalculateAncestors でボトムアップ集約されているため、
  // 直接の子のみ見ればよい（recalcAncestors の再帰呼び出しで孫以降の変更も反映される）。
  //   例) 子 ACT 3 件がすべて user-A → 親 WP も user-A
  //       子 ACT が user-A と user-B 混在 → 親 WP は null
  //       子がすべて未アサイン (null) → 親 WP も null
  const distinctAssignees = new Set(children.map((c) => c.assigneeId));
  const uniformAssignee: string | null
    = distinctAssignees.size === 1 ? [...distinctAssignees][0] : null;

  return {
    plannedEffort: totalEffort,
    progressRate: weightedProgress,
    plannedStartDate: minDate(pickDates((c) => c.plannedStartDate)),
    plannedEndDate: maxDate(pickDates((c) => c.plannedEndDate)),
    actualStartDate: normalized.actualStartDate,
    actualEndDate: normalized.actualEndDate,
    status: wpStatus,
    assigneeId: uniformAssignee,
  };
}

/**
 * 集計結果が WP の現在値と完全一致するかを判定する純関数。
 *
 * 早期スキップ (C 案) 判定に使う: バックフィル等で全 WP を走査したときに
 * 既に正しい値が入っていれば update を省略し DB ラウンドトリップを削減する。
 *
 * Date / Decimal / null などの個別比較を意識して書いているので、型不一致で
 * 常に false を返す事故を避けられる。
 */
export function isWpAggregationEqual(
  current: {
    plannedEffort: Prisma.Decimal | number;
    progressRate: number;
    plannedStartDate: Date | null;
    plannedEndDate: Date | null;
    actualStartDate: Date | null;
    actualEndDate: Date | null;
    status: string;
    assigneeId: string | null;
  },
  next: WpAggregationResult,
): boolean {
  const sameDate = (a: Date | null, b: Date | null): boolean => {
    if (a === null && b === null) return true;
    if (a === null || b === null) return false;
    return a.getTime() === b.getTime();
  };
  return (
    Number(current.plannedEffort) === next.plannedEffort
    && current.progressRate === next.progressRate
    && sameDate(current.plannedStartDate, next.plannedStartDate)
    && sameDate(current.plannedEndDate, next.plannedEndDate)
    && sameDate(current.actualStartDate, next.actualStartDate)
    && sameDate(current.actualEndDate, next.actualEndDate)
    && current.status === next.status
    && (current.assigneeId ?? null) === (next.assigneeId ?? null)
  );
}

/**
 * 単一 WP を集計し直すだけの関数（祖先への上方伝播なし）。
 *
 * 用途:
 *   - 祖先伝播が必要なときは recalculateAncestors を使う（ACT 更新トリガ経路）
 *   - 全 WP を深度降順で一括処理するバックフィル (recalculateAllProjectWps) は、
 *     ループ側で深度順に漏れなく走査するため、上方伝播は冗長。本関数を呼ぶことで
 *     O(N × depth) → O(N) に削減する (A 案)
 *
 * 最適化 (C 案):
 *   集計結果が現在値と一致する場合は update を呼ばずに早期リターン。
 *   2 回目以降の実行や既に正しい状態のデータでは DB 書込を完全スキップできる。
 *
 * @returns true: update 実行 / false: 値一致によりスキップ
 */
async function recalculateWpOnly(taskId: string): Promise<boolean> {
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
          actualStartDate: true,
          actualEndDate: true,
          status: true,
          type: true,
          assigneeId: true,
        },
      },
    },
  });
  if (!task || task.type !== 'work_package') return false;

  const aggregated = aggregateWpFromChildren(task.childTasks);

  // C 案: 現在値と一致するなら update をスキップ
  if (isWpAggregationEqual(task, aggregated)) {
    return false;
  }

  // assignee はリレーション経由での更新が必要（Prisma の update は scalar FK を直書きできない場合がある）
  const { assigneeId, ...rest } = aggregated;
  await prisma.task.update({
    where: { id: taskId },
    data: {
      ...rest,
      assignee: assigneeId
        ? { connect: { id: assigneeId } }
        : { disconnect: true },
    },
  });
  return true;
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
          actualStartDate: true,
          actualEndDate: true,
          status: true,
          type: true,
          assigneeId: true,
        },
      },
    },
  });
  if (!task || task.type !== 'work_package') return;

  const aggregated = aggregateWpFromChildren(task.childTasks);
  // assignee はリレーション経由での更新が必要（Prisma の update は scalar FK を直書きできない場合がある）
  const { assigneeId, ...rest } = aggregated;
  await prisma.task.update({
    where: { id: taskId },
    data: {
      ...rest,
      assignee: assigneeId
        ? { connect: { id: assigneeId } }
        : { disconnect: true },
    },
  });

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

  // タスクIDセット（子の探索用）
  const taskIdSet = new Set(tasks.map((t) => t.id));

  // 各タスクの深さを計算
  function calcLevel(task: typeof tasks[0]): number {
    let level = 1;
    let currentParentId = task.parentTaskId;
    while (currentParentId && taskIdSet.has(currentParentId)) {
      level++;
      const parent = tasks.find((t) => t.id === currentParentId);
      if (!parent) break;
      currentParentId = parent.parentTaskId;
    }
    return level;
  }

  // 深さ優先でツリー順に並べ替え
  type FlatRow = { level: number; task: typeof tasks[0] };
  const rows: FlatRow[] = [];
  const visited = new Set<string>();

  function walkTree(parentId: string | null) {
    const children = tasks
      .filter((t) => t.parentTaskId === parentId)
      .sort((a, b) => {
        const sa = a.plannedStartDate?.getTime() ?? 0;
        const sb = b.plannedStartDate?.getTime() ?? 0;
        return sa - sb || a.createdAt.getTime() - b.createdAt.getTime();
      });
    for (const child of children) {
      if (visited.has(child.id)) continue;
      visited.add(child.id);
      rows.push({ level: calcLevel(child), task: child });
      walkTree(child.id);
    }
  }

  // ルート（親がないか、親が対象外）から開始
  const rootTasks = tasks.filter((t) => !t.parentTaskId || !taskIdSet.has(t.parentTaskId));
  for (const root of rootTasks) {
    if (visited.has(root.id)) continue;
    visited.add(root.id);
    rows.push({ level: 1, task: root });
    walkTree(root.id);
  }

  // CSV 生成
  const csvLines = [CSV_HEADERS.join(',')];
  for (const { level, task: t } of rows) {
    const line = [
      String(level),
      t.type === 'work_package' ? 'WP' : 'ACT',
      escapeCsvField(t.name),
      escapeCsvField(t.wbsNumber),
      safeDate(t.plannedStartDate) ?? '',
      safeDate(t.plannedEndDate) ?? '',
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
  // BOM を除去
  const cleanText = csvText.replace(/^\uFEFF/, '');
  const lines = cleanText.split(/\r?\n/).filter((l) => l.trim());
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

  // 逐次作成（PgBouncer 環境では $transaction が使えないため）
  // エラー時は作成済みタスクを物理削除してロールバック（データ残存なし）
  const idMap = new Map<string, string>();
  const createdIds: string[] = [];

  try {
    for (const t of sorted) {
      const parentId = t.parentTempId ? idMap.get(t.parentTempId) ?? null : null;
      const isActivity = t.type === 'activity';

      const created = await prisma.task.create({
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
      createdIds.push(created.id);
    }
  } catch (e) {
    // エラー時: 作成済みタスクを物理削除してロールバック
    if (createdIds.length > 0) {
      await prisma.task.deleteMany({
        where: { id: { in: createdIds } },
      });
    }
    throw e;
  }

  // WP の集計を更新
  const wpIds = sorted.filter((t) => t.type === 'work_package').map((t) => idMap.get(t.tempId)!);
  for (const wpId of wpIds.reverse()) {
    await recalculateAncestorsPublic(wpId);
  }

  return idMap.size;
}

