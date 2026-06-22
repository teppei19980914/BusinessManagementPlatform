/**
 * タスク (WBS) サービス — 本プロダクトで最大かつ最複雑のサービス層
 *
 * 役割:
 *   プロジェクトの WBS (Work Breakdown Structure) と進捗管理を担う。
 *   - ワークパッケージ (WP) / アクティビティ (ACT) の階層構造
 *   - 計画/実績の日程・工数
 *   - 進捗ログ (task_progress_logs) の追記管理
 *   - WP の値 (期間 / 工数 / 進捗率) は子 ACT から自動集計
 *   - WBS テンプレート展開 (新規プロジェクト初期投入)
 *   - 一括更新 (bulk update) と再計算 (recalculate) のロジック
 *
 * 設計判断:
 *   - WP/ACT 区別 (PR #29 / 20260416 マイグレーション):
 *       type='work_package' は集約用、assignee_id / 計画日程 / 工数は null 許容
 *       type='activity' は実作業、assignee_id 必須
 *   - WP の集計値 (planned_effort / planned_start_date / planned_end_date /
 *     progress_rate) は子 ACT 群から計算する。手動編集を許容すると整合性が崩れるため
 *     WP は集計対象列の直接更新を禁止し、recalculateWp() で再計算する設計。
 *   - 進捗率と状態の双方向整合 (PR #69): progress=100% なら status='completed' を
 *     強制 / status='completed' なら progress=100% を強制。
 *   - 論理削除 (deletedAt) を採用。完了タスクの振り返り参照のため。
 *   - 一覧は階層ツリー (listTasksWithTree) を 1 クエリ + メモリ上構築で返す。
 *     N+1 を避けるため findMany() で全件取得 → JS で親子組み立て。
 *
 * 関数の規模:
 *   ファイル全体 1200+ 行のため、機能別にコメントブロックで区切ってある。
 *   主な関数群:
 *     - DTO 変換 (toTaskDTO 等)
 *     - 一覧取得 (listTasks / listTasksWithTree / listMyTasks)
 *     - 単体 CRUD (createTask / updateTask / deleteTask)
 *     - WP 集計 (recalculateWp / recalculateAllWp)
 *     - 進捗ログ (addProgressLog)
 *     - 一括更新 (bulkUpdateTasks / bulkUpdateActuals)
 *     - WBS テンプレート展開 (createTasksFromTemplate)
 *     - インポート/エクスポート (importTasksFromCsv / exportTasksToCsv)
 *
 * 認可:
 *   呼び出し元 API ルート (/api/projects/[id]/tasks/...) で
 *   checkProjectPermission('task:*') を実施済みの前提。
 *
 * 関連ドキュメント:
 *   - DESIGN.md §5 (テーブル定義: tasks / task_progress_logs)
 *   - DESIGN.md §8 (権限制御 — task アクション)
 *   - DESIGN.md §15 (インデックス戦略 — idx_tasks_gantt 等)
 *   - DESIGN.md §17 (パフォーマンス要件 / N+1 回避)
 *   - SPECIFICATION.md (WBS 管理画面 / ガントチャート / マイタスク画面)
 */

import { prisma } from '@/lib/db';
import type { Prisma } from '@/generated/prisma/client';
import type { UpdateProgressInput } from '@/lib/validators/task';
import type { z } from 'zod/v4';
import type { createTaskSchema, updateTaskSchema } from '@/lib/validators/task';
// PR #361 (2026-05-14): 日次工数プレビュー閾値定数
import { classifyWorkloadLevel, type WorkloadLevel } from '@/config/workload';
import { distributeEffortByDay } from '@/lib/task-day-distribution';
// fix/csv-import-multiline-text-data-loss: RFC 4180 準拠の multi-line cell 対応 CSV パーサ
import { parse as parseCsvSync } from 'csv-parse/sync';

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
  /** v1.3.0: 複数担当者を "名前 +N" 形式で表示するテキスト。単一担当者時は null。 */
  assigneeDisplayText?: string | null;
  plannedStartDate: string | null;
  plannedEndDate: string | null;
  actualStartDate: string | null;
  actualEndDate: string | null;
  plannedEffort: number;
  /** ACT の実績工数 (人時)。未入力は null。WP は (現状) null。 */
  actualEffort: number | null;
  priority: string | null;
  status: string;
  progressRate: number;
  isMilestone: boolean;
  includeWeekends: boolean;
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
  actualEffort: Prisma.Decimal | null;
  priority: string | null;
  status: string;
  progressRate: number;
  isMilestone: boolean;
  includeWeekends: boolean;
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
    actualEffort: t.actualEffort == null ? null : Number(t.actualEffort),
    priority: t.priority,
    status: t.status,
    progressRate: t.progressRate,
    isMilestone: t.isMilestone,
    includeWeekends: t.includeWeekends,
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
/**
 * 「マイタスク」画面用: 閲覧ユーザがアサインされている ACT を
 * プロジェクト別にグルーピングして、各プロジェクト毎に WBS 階層ツリーを返す。
 *
 * 呼び出し順序:
 *   1) ユーザが担当する ACT が所属するプロジェクト ID 集合を特定
 *   2) プロジェクト名を取得 (論理削除は除外)
 *   3) 各プロジェクトで listTasks(projectId) → filterTreeByAssignee で
 *      担当 ACT とその祖先 WP のみ残す
 *
 * クエリ数は N+2 (プロジェクト数 N) で MVP 許容範囲。
 * 1 人のユーザが多数プロジェクトに跨がる場合は将来最適化検討。
 */
/**
 * 2026-05-09 feedback Phase 2: severity-1 テナント越境対策。
 *   Task テーブルは tenantId 列を持たず、project の tenantId に依存する設計のため、
 *   `project: { tenantId: viewerTenantId }` の関連フィルタで自テナント限定する。
 *   ユーザは自テナント内のプロジェクトのタスクのみ assigneeId に持つはずだが、
 *   防御深化として project tenant 検証を併せる (テナント間で userId 衝突した際のフェイルセーフ)。
 */
export async function listMyTaskProjects(userId: string, viewerTenantId: string): Promise<{
  projectId: string;
  projectName: string;
  tree: TaskDTO[];
}[]> {
  const assignments = await prisma.task.findMany({
    where: {
      assigneeId: userId,
      type: 'activity',
      deletedAt: null,
      project: { tenantId: viewerTenantId },
    },
    select: { projectId: true },
  });
  const projectIds = [...new Set(assignments.map((a) => a.projectId))];
  if (projectIds.length === 0) return [];

  const projects = await prisma.project.findMany({
    where: { id: { in: projectIds }, tenantId: viewerTenantId, deletedAt: null },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });

  // filterTreeByAssignee は動的 import で循環依存を避ける (同じパッケージ内でも可読性優先)
  const { filterTreeByAssignee } = await import('@/lib/task-tree-utils');

  // PR-3 perf (2026-05-29): N+1 解消。
  //   旧実装は projects.map で各プロジェクトに対し `listTasks(p.id)` を並列実行していた。
  //   `Promise.all` で並列化されているとはいえ、内部で各々が個別 findMany + buildTree を
  //   実行するため、プロジェクト数 N に対し N 回の DB ラウンドトリップが発生していた
  //   (Beginner プランで 5 件、Pro/Expert で 10-20 件の遅延が顕著)。
  //
  //   新実装は **1 回の findMany** で全プロジェクト分の Task を一括取得し、JS 側で
  //   projectId ごとに O(N) でグルーピングしてから buildTree / filterTreeByAssignee を
  //   適用する。集約結果は旧実装と完全に同じ (順序・親子関係・filtered tree)。
  const allTasks = await prisma.task.findMany({
    where: {
      projectId: { in: projectIds },
      deletedAt: null,
      project: { tenantId: viewerTenantId },
    },
    include: { assignee: { select: { name: true } }, parentTask: { select: { name: true } } },
    orderBy: [{ plannedStartDate: 'asc' }, { plannedEndDate: 'asc' }, { createdAt: 'asc' }],
  });

  const tasksByProjectId = new Map<string, typeof allTasks>();
  for (const task of allTasks) {
    const list = tasksByProjectId.get(task.projectId);
    if (list) {
      list.push(task);
    } else {
      tasksByProjectId.set(task.projectId, [task]);
    }
  }

  return projects.map((p) => {
    const projectTasks = tasksByProjectId.get(p.id) ?? [];
    const dtos = projectTasks.map(toTaskDTO);
    const tree = buildTree(dtos);
    const filtered = filterTreeByAssignee(tree, new Set([userId]));
    return { projectId: p.id, projectName: p.name, tree: filtered };
  });
}

/**
 * 2026-05-09 feedback Phase 2: viewerTenantId を必須化し、Task の project リレーション経由で
 *   テナント越境を遮断する。projectId 直叩きで他テナントの WBS を全件取得する経路を塞ぐ。
 */
export async function listTasks(projectId: string, viewerTenantId: string): Promise<TaskDTO[]> {
  const tasks = await prisma.task.findMany({
    where: { projectId, deletedAt: null, project: { tenantId: viewerTenantId } },
    include: { assignee: { select: { name: true } }, parentTask: { select: { name: true } } },
    orderBy: [{ plannedStartDate: 'asc' }, { plannedEndDate: 'asc' }, { createdAt: 'asc' }],
  });

  const dtos = tasks.map(toTaskDTO);
  return buildTree(dtos);
}

/**
 * タスクの平坦リストを WBS 階層ツリーに組み立てる純粋関数。
 *
 * アルゴリズム:
 *   1. 全タスクを id → ノード の Map に登録 (初期 children=[])
 *   2. 各タスクの parentTaskId を辿り、親が見つかれば子配列に追加、なければルート扱い
 *
 * なぜ DB 側で再帰 CTE を使わないか:
 *   - 1 プロジェクトのタスクは数百件オーダーが現実的で、1 クエリ + JS 構築で十分高速
 *   - 再帰 CTE は Prisma で扱いづらく、保守コストが高い
 *
 * 注意:
 *   - 親が deletedAt 済み等で見つからない孤児ノードはルートとして扱う (データ消失防止)
 *   - 各ノードは元 DTO のシャローコピーで、children のみ書き換える
 */
export function buildTree(tasks: TaskDTO[]): TaskDTO[] {
  const map = new Map<string, TaskDTO>();
  const roots: TaskDTO[] = [];

  // Step 1: 全ノードを Map に登録。新しいオブジェクトとして children=[] を持たせる。
  for (const task of tasks) {
    map.set(task.id, { ...task, children: [] });
  }

  // Step 2: 親子関係を組み立て。親不在 (= 削除済 or トップレベル) はルート。
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
 *
 * 2026-05-09 feedback Phase 2: viewerTenantId 必須化、project リレーション経由で越境遮断。
 */
export async function listTasksFlat(projectId: string, viewerTenantId: string): Promise<TaskDTO[]> {
  const tasks = await prisma.task.findMany({
    where: { projectId, deletedAt: null, project: { tenantId: viewerTenantId } },
    include: { assignee: { select: { name: true } }, parentTask: { select: { name: true } } },
    orderBy: [{ plannedStartDate: 'asc' }, { plannedEndDate: 'asc' }, { createdAt: 'asc' }],
  });
  return tasks.map(toTaskDTO);
}

// ================================================================
// 2026-05-09 (PR H / #7): 担当者別 日次工数集計
// ================================================================

export type DailyWorkloadEntry = {
  /** YYYY-MM-DD (UTC ベース) */
  date: string;
  /** 当日の予定工数 (= タスク plannedEffort を期間で按分した合計) */
  effortHours: number;
};

export type AssigneeWorkloadRow = {
  assigneeId: string;
  assigneeName: string;
  /** assignee がアサインされている activity 数 */
  taskCount: number;
  /** 期間総工数 (タスク plannedEffort の単純合計) */
  totalEffortHours: number;
  /** 日次内訳 (date 昇順、effort=0 の日は含めない) */
  daily: DailyWorkloadEntry[];
};

/**
 * 担当者別の日次工数を集計する (#7 / 2026-05-09)。
 *
 * アルゴリズム:
 *   - assignee + plannedStartDate + plannedEndDate + plannedEffort > 0 が揃った
 *     activity (type='activity') のみ対象 (= 集約 WP は子に按分されているので除外)
 *   - 各タスクの plannedEffort を期間 (start-end の inclusive) の日数で **均等に按分**
 *     例: plannedEffort=8h, 期間 4 日 → 1 日 2h を各日に加算
 *   - assignee × date で合計
 *
 * 設計判断:
 *   - 営業日 (祝日除外) ベースの按分は将来拡張余地。MVP は単純按分で十分
 *   - effort=0 の日は daily 配列から除外 (ペイロード削減)
 *   - 並び順: 担当者は totalEffortHours 降順、daily は date 昇順
 */
export async function getAssigneeDailyWorkload(
  projectId: string,
  viewerTenantId: string,
): Promise<AssigneeWorkloadRow[]> {
  // 2026-05-09 feedback Phase 2: project tenant 越境遮断。
  const tasks = await prisma.task.findMany({
    where: {
      projectId,
      deletedAt: null,
      type: 'activity',
      assigneeId: { not: null },
      plannedStartDate: { not: null },
      plannedEndDate: { not: null },
      project: { tenantId: viewerTenantId },
    },
    select: {
      assigneeId: true,
      assignee: { select: { name: true } },
      plannedStartDate: true,
      plannedEndDate: true,
      plannedEffort: true,
      includeWeekends: true,
    },
  });

  // assigneeId → { name, taskCount, totalEffort, dailyMap (date → effort) }
  type Acc = {
    name: string;
    taskCount: number;
    totalEffortHours: number;
    dailyMap: Map<string, number>;
  };
  const byAssignee = new Map<string, Acc>();

  for (const t of tasks) {
    if (!t.assigneeId || !t.plannedStartDate || !t.plannedEndDate) continue;
    const effort = Number(t.plannedEffort);
    if (effort <= 0) continue;

    const startStr = t.plannedStartDate.toISOString().split('T')[0]!;
    const endStr = t.plannedEndDate.toISOString().split('T')[0]!;
    const entries = distributeEffortByDay(startStr, endStr, effort, t.includeWeekends);
    if (entries.length === 0) continue;

    const acc = byAssignee.get(t.assigneeId) ?? {
      name: t.assignee?.name ?? '(unknown)',
      taskCount: 0,
      totalEffortHours: 0,
      dailyMap: new Map<string, number>(),
    };
    acc.taskCount += 1;
    acc.totalEffortHours += effort;

    for (const entry of entries) {
      acc.dailyMap.set(entry.date, (acc.dailyMap.get(entry.date) ?? 0) + entry.dailyEffort);
    }
    byAssignee.set(t.assigneeId, acc);
  }

  return Array.from(byAssignee.entries())
    .map(([assigneeId, acc]) => ({
      assigneeId,
      assigneeName: acc.name,
      taskCount: acc.taskCount,
      totalEffortHours: round(acc.totalEffortHours, 2),
      daily: Array.from(acc.dailyMap.entries())
        .map(([date, effortHours]) => ({ date, effortHours: round(effortHours, 2) }))
        .sort((a, b) => a.date.localeCompare(b.date)),
    }))
    .sort((a, b) => b.totalEffortHours - a.totalEffortHours);
}

function round(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

// ================================================================
// PR #361 (2026-05-14): ACT 編集時の日次工数プレビュー
// ================================================================

export type WorkloadPreviewInput = {
  projectId: string;
  /** プレビュー対象の担当者 ID */
  assigneeId: string;
  /** 入力中のタスクの計画開始日 ('YYYY-MM-DD') */
  startDate: string;
  /** 入力中のタスクの計画終了日 ('YYYY-MM-DD') */
  endDate: string;
  /** 入力中のタスクの計画工数 (時間) */
  plannedEffort: number;
  /** 編集時に自タスクを既存集計から除外する。新規作成時は undefined */
  excludeTaskId?: string;
  /** テナント境界 (severity-1 越境防止) */
  viewerTenantId: string;
  /** true=土日祝日を稼働日に含む、false=平日のみ（デフォルト: false） */
  includeWeekends?: boolean;
};

export type WorkloadPreviewResult = {
  /** 期間内の最大日工数 (時間、小数点 2 桁丸め) */
  maxDailyEffort: number;
  /** 最大日工数が現れる日付 ('YYYY-MM-DD')。入力範囲が無効なら null */
  maxDailyDate: string | null;
  /** UI 色付け用レベル (`classifyWorkloadLevel` の結果) */
  level: WorkloadLevel;
};

/**
 * ACT 作成・編集中の入力 (開始日・終了日・担当者・工数) から、
 * 当該担当者の **現プロジェクト内** の日次工数を、既存タスク + 入力中タスクで
 * 合算して 1 日あたりの最大値を返す。
 *
 * アルゴリズム:
 *   - 既存 ACT (type='activity', assigneeId=X, 期間 + 工数あり) を取得
 *   - excludeTaskId が指定されていれば除外 (= 編集時の自タスク二重カウント防止)
 *   - 各既存タスクの工数を期間日数で均等按分し、日付 → 工数 の Map に集計
 *   - 入力中タスクも同様に按分して同 Map に加算
 *   - 入力期間内の各日について最大値を探索
 *
 * テナント分離 (severity-1):
 *   - where 句に `project: { tenantId: viewerTenantId }` を必須付与
 *   - 別テナントの task が混入しないことを invariant テストで保証
 *
 * @returns { maxDailyEffort, maxDailyDate, level } 入力が無効なら maxDailyEffort=0, maxDailyDate=null, level='ok'
 */
export async function previewActivityWorkload(
  input: WorkloadPreviewInput,
): Promise<WorkloadPreviewResult> {
  const startDate = new Date(`${input.startDate}T00:00:00.000Z`);
  const endDate = new Date(`${input.endDate}T00:00:00.000Z`);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime()) || startDate > endDate) {
    return { maxDailyEffort: 0, maxDailyDate: null, level: classifyWorkloadLevel(0) };
  }

  // 既存 ACT を取得 (severity-1: tenantId フィルタ必須)
  const existingTasks = await prisma.task.findMany({
    where: {
      projectId: input.projectId,
      deletedAt: null,
      type: 'activity',
      assigneeId: input.assigneeId,
      plannedStartDate: { not: null },
      plannedEndDate: { not: null },
      project: { tenantId: input.viewerTenantId },
      ...(input.excludeTaskId ? { id: { not: input.excludeTaskId } } : {}),
    },
    select: {
      plannedStartDate: true,
      plannedEndDate: true,
      plannedEffort: true,
      includeWeekends: true,
    },
  });

  // 日付 → 工数 の集計 Map
  const dailyMap = new Map<string, number>();

  for (const t of existingTasks) {
    if (!t.plannedStartDate || !t.plannedEndDate) continue;
    const effort = Number(t.plannedEffort);
    if (effort <= 0) continue;
    const startStr = t.plannedStartDate.toISOString().split('T')[0]!;
    const endStr = t.plannedEndDate.toISOString().split('T')[0]!;
    const entries = distributeEffortByDay(startStr, endStr, effort, t.includeWeekends);
    for (const entry of entries) {
      dailyMap.set(entry.date, (dailyMap.get(entry.date) ?? 0) + entry.dailyEffort);
    }
  }

  // 入力中タスクを加算
  if (input.plannedEffort > 0) {
    const entries = distributeEffortByDay(input.startDate, input.endDate, input.plannedEffort, input.includeWeekends);
    for (const entry of entries) {
      dailyMap.set(entry.date, (dailyMap.get(entry.date) ?? 0) + entry.dailyEffort);
    }
  }

  // 入力期間内の稼働日について最大値を探索
  const inputEntries = distributeEffortByDay(input.startDate, input.endDate, 0, input.includeWeekends);
  let maxEffort = 0;
  let maxDate: string | null = null;
  for (const entry of inputEntries) {
    const effort = dailyMap.get(entry.date) ?? 0;
    if (effort > maxEffort) {
      maxEffort = effort;
      maxDate = entry.date;
    }
  }

  const rounded = round(maxEffort, 2);
  return {
    maxDailyEffort: rounded,
    maxDailyDate: maxDate,
    level: classifyWorkloadLevel(rounded),
  };
}

/**
 * ツリー構造とフラット構造を同時に必要とする画面向け。
 * 1 回の DB クエリで両方のビューを生成する（listTasks + listTasksFlat の 2 クエリを集約）。
 * ツリー内のノードと flat のノードは別オブジェクトなので、双方を独立に変更しても影響しない。
 */
export async function listTasksWithTree(
  projectId: string,
  viewerTenantId: string,
): Promise<{ tree: TaskDTO[]; flat: TaskDTO[] }> {
  const tasks = await prisma.task.findMany({
    where: { projectId, deletedAt: null, project: { tenantId: viewerTenantId } },
    include: { assignee: { select: { name: true } }, parentTask: { select: { name: true } } },
    orderBy: [{ plannedStartDate: 'asc' }, { plannedEndDate: 'asc' }, { createdAt: 'asc' }],
  });
  const flat = tasks.map(toTaskDTO);
  return { tree: buildTree(flat), flat };
}

/**
 * 2026-05-09 feedback Phase 2: viewerTenantId 必須化。taskId 直叩きで他テナントのタスクが
 *   read される経路を遮断 (個人情報含む name / description が漏洩する severity-1 リスク)。
 */
export async function getTask(taskId: string, viewerTenantId: string): Promise<TaskDTO | null> {
  const task = await prisma.task.findFirst({
    where: { id: taskId, deletedAt: null, project: { tenantId: viewerTenantId } },
    include: { assignee: { select: { name: true } }, parentTask: { select: { name: true } } },
  });
  return task ? toTaskDTO(task) : null;
}

/**
 * タスク (WP または ACT) を新規作成する。
 *
 * WP / ACT の差異 (PR #29 / 20260416 マイグレーション参照):
 *   - ACT (アクティビティ): 実作業単位。assigneeId / 計画日程 / 工数 / 優先度が必須
 *   - WP (ワークパッケージ): 集約単位。これらは null/0 で作成し、子 ACT から自動集計
 *
 * 副作用 (重要):
 *   parentTaskId が指定されている (= この新タスクが既存タスクの子) 場合、
 *   親 WP の集計値 (planned_effort / planned_start_date / planned_end_date /
 *   progress_rate) が変わる可能性があるため、recalculateAncestors() で
 *   先祖チェーンを根まで再計算する。
 *
 * 認可: 呼び出し元 API ルートで checkProjectPermission('task:create') 実施済の前提。
 *
 * 名称の重複について (ADR-0032, 2026-06-04):
 *   旧実装 (ADR-0017) は「同一 WP 配下の同名タスク」を禁止していたが、業務上は週内に
 *   繰り返す学習タスク等で同名が正当に発生する。タスクの突合は ID (UUID) のみで行うため
 *   同名でも機能は壊れない。よって名称一意性ガードは撤廃し、同名を許容する。
 */
export async function createTask(
  projectId: string,
  input: CreateTaskInput,
  userId: string,
  viewerTenantId: string,
): Promise<TaskDTO> {
  // 2026-05-09 feedback Phase 2: 越境 create を遮断する所有確認。
  //   呼び出し元 (checkProjectPermission) も Phase 1 で塞いだが、defense-in-depth として
  //   service 層でも project の tenant 一致を verify する。NOT_FOUND を返すか throw するかは
  //   呼び出し側の挙動と整合させるため、不一致なら throw NOT_FOUND。
  const project = await prisma.project.findFirst({
    where: { id: projectId, tenantId: viewerTenantId },
    select: { id: true },
  });
  if (!project) throw new Error('NOT_FOUND');

  // ADR-0032 (2026-06-04): 名称一意性ガードは撤廃 (同一 WP 配下の同名タスクを許容)。

  const isActivity = input.type === 'activity';

  // ACT の場合は計画値・担当を渡す。WP は集計対象なので null / 0 / false で作成。
  // 後段の recalculateAncestors で子 ACT から正しい値が逆算されるため初期値はダミー。
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
      includeWeekends: isActivity ? (input.includeWeekends ?? false) : false,
      notes: input.notes,
      createdBy: userId,
      updatedBy: userId,
    },
    include: { assignee: { select: { name: true } }, parentTask: { select: { name: true } } },
  });

  // 子追加によって親 WP の集計値が変わるため先祖を再計算 (DB 整合性の最後の砦)。
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

/**
 * タスクを編集する。部分更新 (PATCH 相当) で、input に存在するフィールドのみ書き換え。
 *
 * 整合性ロジックの順序 (重要):
 *   1. status / progressRate / actualStartDate / actualEndDate のいずれかが
 *      指定された場合、現在値と input から「最終状態」を確定する
 *   2. PR #69 の双方向ルール:
 *      - progress=100 ⇒ status=completed (100% は必ず完了)
 *      - status=completed ⇒ progress=100 (完了は必ず 100%)
 *   3. status に応じて actualStartDate / actualEndDate を正規化
 *      (未着手なら両方 null、進行中/保留なら end のみ null、完了なら両方保持)
 *   4. DB 書き込み
 *   5. 親 WP の集計値を再計算 (recalculateAncestors)
 *
 * 親変更 (parentTaskId) の特殊ケース:
 *   旧親 / 新親の両方を再計算する必要があるため、変更前後の parentTaskId を
 *   記録して両方を更新する。これを忘れると旧親に「もう存在しない子」の集計値が
 *   残ってしまう。
 *
 * 認可: 呼び出し元 API ルートで checkProjectPermission('task:edit') 実施済の前提。
 */
export async function updateTask(
  taskId: string,
  input: UpdateTaskInput,
  userId: string,
  viewerTenantId: string,
): Promise<TaskDTO> {
  // 2026-05-09 feedback Phase 2: 越境編集を遮断するため task の project tenant 一致を verify。
  //   findFirst で先に検証することで、taskId 直叩きの編集を NOT_FOUND として弾く。
  // ADR-0035 (2026-06-05): 所有確認に加え、status 整合性正規化で使う現在値 (status/progress/actual)
  //   も同じ findFirst で取得する。旧実装は後段で別途 findUnique を呼び同一行を二重 fetch していた。
  const owned = await prisma.task.findFirst({
    where: { id: taskId, deletedAt: null, project: { tenantId: viewerTenantId } },
    select: {
      id: true,
      status: true,
      progressRate: true,
      actualStartDate: true,
      actualEndDate: true,
      actualEffort: true,
    },
  });
  if (!owned) throw new Error('NOT_FOUND');

  // ADR-0032 (2026-06-04): 名称一意性ガードは撤廃 (同一 WP 配下の同名タスクを許容)。

  const data: Prisma.TaskUpdateInput = { updatedBy: userId };
  // 更新後に確定するステータス (status/progress 整合性ルール適用後)。既定は現状維持。
  let finalStatus: string = owned.status;

  if (input.type !== undefined) data.type = input.type;
  if (input.parentTaskId !== undefined) data.parentTask = input.parentTaskId ? { connect: { id: input.parentTaskId } } : { disconnect: true };
  if (input.wbsNumber !== undefined) data.wbsNumber = input.wbsNumber;
  if (input.name !== undefined) data.name = input.name;
  if (input.description !== undefined) data.description = input.description;
  if (input.assigneeId !== undefined) data.assignee = input.assigneeId ? { connect: { id: input.assigneeId } } : { disconnect: true };
  if (input.plannedStartDate !== undefined) data.plannedStartDate = input.plannedStartDate ? new Date(input.plannedStartDate) : null;
  if (input.plannedEndDate !== undefined) data.plannedEndDate = input.plannedEndDate ? new Date(input.plannedEndDate) : null;
  if (input.plannedEffort !== undefined) data.plannedEffort = input.plannedEffort;
  if (input.actualEffort !== undefined) data.actualEffort = input.actualEffort;
  if (input.priority !== undefined) data.priority = input.priority;
  if (input.progressRate !== undefined) data.progressRate = input.progressRate;
  if (input.isMilestone !== undefined) data.isMilestone = input.isMilestone;
  if (input.includeWeekends !== undefined) data.includeWeekends = input.includeWeekends;
  if (input.notes !== undefined) data.notes = input.notes;

  // status / progressRate / actualStartDate / actualEndDate はステータス整合性ルールに基づき一括正規化する。
  // どれか 1 つでも変わる場合は現在値を読んで final 状態を確定し、ルール適用後に書き込む。
  if (
    input.status !== undefined
    || input.progressRate !== undefined
    || input.actualStartDate !== undefined
    || input.actualEndDate !== undefined
  ) {
    // ADR-0035: 冒頭の owned (findFirst) で取得済みの現在値を再利用 (二重 fetch 回避)。
    const current = owned;

    const inputStatus = input.status;
    const inputProgress = input.progressRate;
    // PR #69 Task 1: status と progressRate の整合性を双方向に強制する。
    // (既存: status=completed → progress=100 / 新規: progress=100 → status=completed)
    //
    // 同時指定時の優先順:
    //   - progress=100 と status!=completed を同時に受け取った場合は
    //     「進捗 100% ならば完了」の方を優先 (業務ルールとして「100% で未完了」は矛盾するため)
    //   - progress<100 と status=completed を同時に受け取った場合は従来通り
    //     「status=completed → progress=100」を優先
    finalStatus = inputStatus ?? current.status;
    if (inputProgress === 100 && finalStatus !== 'completed') {
      finalStatus = 'completed';
    }
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

  // 2026-06-15 ユーザ要件: ステータス=完了 のとき実績工数は必須 (> 0)。
  //   最終的な実績工数 = input 指定があればそれ、無ければ現在値。完了かつ 0/未入力なら拒否。
  if (finalStatus === 'completed') {
    const effectiveActualEffort
      = input.actualEffort !== undefined ? input.actualEffort : owned.actualEffort;
    if (!(effectiveActualEffort != null && Number(effectiveActualEffort) > 0)) {
      throw new Error('ACTUAL_EFFORT_REQUIRED');
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

/**
 * タスクを論理削除する (deletedAt にタイムスタンプを設定)。
 *
 * なぜ物理削除しないか:
 *   削除されたタスクが残した進捗ログ (task_progress_logs) や、過去の振り返りで
 *   参照されていた可能性があるため、関係先の整合性を維持する目的で論理削除を採用。
 *
 * 子タスクの扱い:
 *   現状は親タスクの deletedAt 設定のみで、子の deletedAt は更新しない。
 *   listTasks の WHERE deletedAt=null フィルタで親が消えたツリーは描画されないため、
 *   実用上は問題なし (孤児ノードは buildTree でルート扱いされる)。
 *
 * 副作用:
 *   親 WP が存在する場合は集計再計算 (子が消えた → 親の合計工数等が変わる)。
 */
export async function deleteTask(
  taskId: string,
  projectId: string,
  userId: string,
  viewerTenantId: string,
): Promise<TaskDTO | null> {
  // ADR-0035 (2026-06-05): 所有確認 (越境/別 project/既削除の除外) と監査用 before 値の取得を
  //   1 回の fetch に集約する。旧実装は呼び出し側 route の getTask と、ここでの所有確認
  //   findFirst で同一行を二重 fetch していた (越境防止: project.tenantId + projectId を verify)。
  const before = await prisma.task.findFirst({
    where: { id: taskId, projectId, deletedAt: null, project: { tenantId: viewerTenantId } },
    include: { assignee: { select: { name: true } }, parentTask: { select: { name: true } } },
  });
  if (!before) return null; // route 側で 404 にマップ

  // PR #89: 紐づく Attachment も同時に論理削除 (UI アクセス不可の孤児データ防止)
  // PR fix/visibility-auth-matrix (2026-05-01): Comment も cascade soft-delete (§5.51)
  const now = new Date();
  await prisma.$transaction([
    prisma.task.update({
      where: { id: taskId },
      data: { deletedAt: now, updatedBy: userId },
    }),
    prisma.attachment.updateMany({
      // 2026-05-12 severity-1 防御: tenantId 明示
      where: { tenantId: viewerTenantId, entityType: 'task', entityId: taskId, deletedAt: null },
      data: { deletedAt: now },
    }),
    prisma.comment.updateMany({
      where: { tenantId: viewerTenantId, entityType: 'task', entityId: taskId, deletedAt: null },
      data: { deletedAt: now },
    }),
  ]);

  if (before.parentTaskId) {
    await recalculateAncestors(before.parentTaskId);
  }

  return toTaskDTO(before);
}

/**
 * 複数タスクを一括論理削除する (ADR-0035)。
 *
 * 設計:
 *   - 認証/権限は呼び出し元 route で 1 回だけ実施 (件数分くり返さない)。
 *   - 越境/別プロジェクト/既削除の ID は **1 回の findMany で除外**しつつ所有確認する
 *     (deleteTask の per-id findFirst を件数分くり返さない)。
 *   - 本体 + 紐づく Attachment / Comment を `$transaction([updateMany×3])` で一括 soft-delete。
 *   - **WP 集計の再計算はここでは行わない**。チャンクごとに再計算すると O(WP) 走査が重複し
 *     Netlify 10 秒枠に近づくため、呼び出し側 (クライアント) が全チャンク完了後に
 *     `recalculateAllProjectWps` (= POST /tasks/recalculate) を 1 回だけ実行する。
 *
 * 冪等性:
 *   `deletedAt: null` 条件付き updateMany のため、既削除 ID を再投入しても二重削除にならず
 *   結果は変わらない。よって失敗チャンクの再送は安全 (runChunkedBulk の retry 前提)。
 *
 * @returns deletedCount = 実際に soft-delete したタスク件数、deletedIds = その UUID 群 (監査用)。
 */
export async function bulkDeleteTasks(
  projectId: string,
  taskIds: string[],
  userId: string,
  viewerTenantId: string,
): Promise<{ deletedCount: number; deletedIds: string[] }> {
  if (taskIds.length === 0) return { deletedCount: 0, deletedIds: [] };

  // 越境削除を遮断 + 別プロジェクト/既削除を除外。所有確認を 1 query に集約。
  const owned = await prisma.task.findMany({
    where: {
      id: { in: taskIds },
      projectId,
      deletedAt: null,
      project: { tenantId: viewerTenantId },
    },
    select: { id: true },
  });
  const ownedIds = owned.map((t) => t.id);
  if (ownedIds.length === 0) return { deletedCount: 0, deletedIds: [] };

  const now = new Date();
  const [taskResult] = await prisma.$transaction([
    prisma.task.updateMany({
      where: { id: { in: ownedIds } },
      data: { deletedAt: now, updatedBy: userId },
    }),
    // 紐づく Attachment / Comment も同時に論理削除 (孤児データ防止)。tenantId 明示 (severity-1 防御)。
    prisma.attachment.updateMany({
      where: { tenantId: viewerTenantId, entityType: 'task', entityId: { in: ownedIds }, deletedAt: null },
      data: { deletedAt: now },
    }),
    prisma.comment.updateMany({
      where: { tenantId: viewerTenantId, entityType: 'task', entityId: { in: ownedIds }, deletedAt: null },
      data: { deletedAt: now },
    }),
  ]);

  return { deletedCount: taskResult.count, deletedIds: ownedIds };
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
    actualEffort?: number | null;
  },
  userId: string,
  viewerTenantId: string,
): Promise<number> {
  // 2026-05-09 feedback Phase 2: 越境一括更新を遮断するため project tenant 一致を verify。
  const project = await prisma.project.findFirst({
    where: { id: projectId, tenantId: viewerTenantId },
    select: { id: true },
  });
  if (!project) throw new Error('NOT_FOUND');

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
  // 実績工数: 0 / null は未入力としてクリア (null)。WP 集計には影響しない。
  if (updates.actualEffort !== undefined) {
    data.actualEffort = updates.actualEffort && updates.actualEffort > 0 ? updates.actualEffort : null;
  }
  if (updates.progressRate !== undefined) data.progressRate = updates.progressRate;

  // 2026-06-15 ユーザ要件: 完了になる一括更新では実績工数が必須 (> 0)。
  //   - actualEffort を一括指定する場合は > 0 でなければ拒否 (完了にしつつ 0/クリアは不可)。
  //   - 指定しない場合は、完了になる対象 ACT に実工数 0/未入力 が 1 件でもあれば拒否。
  const becomesCompleted = updates.status === 'completed' || updates.progressRate === 100;
  if (becomesCompleted) {
    if (updates.actualEffort !== undefined) {
      if (!(updates.actualEffort != null && updates.actualEffort > 0)) {
        throw new Error('ACTUAL_EFFORT_REQUIRED');
      }
    } else {
      const missing = await prisma.task.findFirst({
        where: {
          id: { in: taskIds },
          projectId,
          deletedAt: null,
          type: 'activity',
          project: { tenantId: viewerTenantId },
          OR: [{ actualEffort: null }, { actualEffort: { lte: 0 } }],
        },
        select: { id: true },
      });
      if (missing) throw new Error('ACTUAL_EFFORT_REQUIRED');
    }
  }

  // ステータス=完了 → 進捗率=100 の整合性ルール（集計前に適用）。
  // bulk では対象タスク全体が一括で completed になるため、progressRate を 100 に揃えても
  // 個別タスクの現行値を壊さない（どのみち全員 completed で統一される）。
  if (updates.status === 'completed') {
    data.progressRate = 100;
  }
  // PR #69 Task 1: 進捗率=100 → ステータス=完了 の逆方向整合性も強制する。
  // bulk で「全件進捗 100% にする」ような運用があった場合でも、状況欄が自動で完了に揃う。
  if (updates.progressRate === 100 && updates.status === undefined) {
    data.status = 'completed';
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
      // 2026-05-09 feedback Phase 2: 越境更新の二重防御 (project tenant 検証は冒頭で済だが、
      //   updateMany の where に併記して projectId 引数偽装の保険にする)。
      project: { tenantId: viewerTenantId },
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
    // ADR-0035: 親ごとの逐次 recalculateAncestors (共有祖先を親数だけ重複再計算) をやめ、
    //   影響 WP (親 ∪ 祖先) を重複なく深度降順で 1 回ずつ再計算する (横広な一括更新の往復削減)。
    //   最終的な WP 集計値は同一。プロジェクト全 WP は走査しない (狭い更新の退行を防ぐ)。
    await recalculateAffectedWps(projectId, viewerTenantId, uniqueParentIds);
  }

  return result.count;
}

/**
 * タスクの進捗を追記する (進捗ログを 1 件追加 + タスク本体の最新値を更新)。
 *
 * データモデル:
 *   - task_progress_logs: 時系列追記 (履歴)。これを集計して「進捗推移グラフ」も表示可能
 *   - tasks 本体の progressRate / actualEffort: 最新値のキャッシュ (検索高速化のため)
 *   両方を 1 トランザクションで更新するため一貫性は保たれる。
 *
 * 整合性ルール (PR #69):
 *   進捗 100% で記録されたら status='completed' に強制更新する。
 *   updateTask 経由ではなく直接 Prisma で更新するためここに同等ルールを再実装。
 *
 * 副作用:
 *   親 WP の集計値 (進捗率の加重平均、status の自動判定等) を再計算する。
 *
 * 認可: 呼び出し元 API ルートで checkProjectPermission('task:update_progress') 実施済の前提。
 */
export async function updateTaskProgress(
  taskId: string,
  input: UpdateProgressInput,
  userId: string,
  viewerTenantId: string,
): Promise<void> {
  // 2026-05-09 feedback Phase 2: 越境進捗更新を遮断するため task の project tenant 一致を verify。
  //   進捗ログ追加 + task 本体更新の前に所有確認。
  const owned = await prisma.task.findFirst({
    where: { id: taskId, deletedAt: null, project: { tenantId: viewerTenantId } },
    select: { id: true },
  });
  if (!owned) throw new Error('NOT_FOUND');

  // 進捗ログを 1 件追記 (時系列履歴を残す)。
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

  // PR #69 Task 1: 双方向の整合性ルール。
  //   - status=completed → progress=100 (既存)
  //   - progress=100 → status=completed (新規、進捗 100% が先でも完了に揃える)
  const finalStatus = input.progressRate === 100 ? 'completed' : input.status;
  const normalized = normalizeActualDatesForStatus(
    finalStatus,
    current?.actualStartDate ?? null,
    current?.actualEndDate ?? null,
  );
  const normalizedProgress = finalStatus === 'completed' ? 100 : input.progressRate;

  // タスク本体の進捗率・ステータス・実績日付を更新
  const task = await prisma.task.update({
    where: { id: taskId },
    data: {
      progressRate: normalizedProgress,
      status: finalStatus,
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
/**
 * recalculateAncestors の公開ラッパー（インポート後の再集計用）。
 * feat/wbs-overwrite-import: sync-import 用にも呼び出すため export する。
 */
export async function recalculateAncestorsPublic(taskId: string): Promise<void> {
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
 * パフォーマンス (2026-04-18 → 2026-06-09 ADR-0037 で全面バッチ化):
 *   旧実装は WP ごとに findUnique(子込み) + update を逐次実行しており、O(WP) の
 *   ラウンドトリップが Netlify 同期関数の 10 秒上限を超えて 504 を誘発していた
 *   (WBS 上書きインポート / 一括削除 finalize / 外部移行で顕在化。ADR-0032 §79 が
 *   SQL 集計化を将来課題として予告済)。
 *
 *   ADR-0037: プロジェクト全タスクを **1 回の findMany** でロードし、メモリ上で
 *   子 → 親 (深度降順) に集計、現在値と異なる WP **だけ**を `$transaction` の配列形
 *   (PgBouncer transaction mode で利用可) で **チャンク一括 update** する。
 *   ラウンドトリップは「全タスク 1 fetch + 変更 WP のチャンク数」で **WP 数に依存しない
 *   ほぼ定数**になる。最終的な格納値は旧逐次実装と完全に同一:
 *   - A 案 (祖先伝播スキップ): 深度降順で子 WP を先に集計し、親はその最新集計値を読む。
 *   - C 案 (一致時スキップ): isWpAggregationEqual で現在値と一致する WP は update しない。
 *
 * @returns { total: 走査した WP 数, updated: 実際に update された WP 数 }
 */
export async function recalculateAllProjectWps(
  projectId: string,
  viewerTenantId: string,
): Promise<{ total: number; updated: number }> {
  // 2026-05-09 feedback Phase 2: 越境再計算を遮断するため project tenant 一致を verify。
  //   tasks は tenantId 列を持たないため、project 経由で自テナント所属を 1 query で確認。
  const project = await prisma.project.findFirst({
    where: { id: projectId, tenantId: viewerTenantId },
    select: { id: true },
  });
  if (!project) return { total: 0, updated: 0 };

  // プロジェクト全タスク (WP + ACT) を 1 回でロード。集計に必要な列のみ。
  //   severity-1 防御 (feedback_verify_dataflow_primary_source_always): 上の project 検証に
  //   加え、越境の境界をこの「書き込み対象を決めるクエリ」自体にも `project: { tenantId }` で直付与する。
  const tasks = await prisma.task.findMany({
    where: { projectId, deletedAt: null, project: { tenantId: viewerTenantId } },
    select: {
      id: true,
      parentTaskId: true,
      type: true,
      plannedEffort: true,
      progressRate: true,
      plannedStartDate: true,
      plannedEndDate: true,
      actualStartDate: true,
      actualEndDate: true,
      status: true,
      assigneeId: true,
    },
  });

  const wps = tasks.filter((t) => t.type === 'work_package');
  if (wps.length === 0) return { total: 0, updated: 0 };

  // 親 ID → 直接の子タスク
  const childrenByParent = new Map<string, typeof tasks>();
  for (const t of tasks) {
    if (!t.parentTaskId) continue;
    const arr = childrenByParent.get(t.parentTaskId) ?? [];
    arr.push(t);
    childrenByParent.set(t.parentTaskId, arr);
  }

  // 深度マップ: 祖先チェーン (WP のみ) の長さ = その WP の深度
  const wpById = new Map(wps.map((w) => [w.id, w]));
  const depthOf = (id: string): number => {
    let d = 0;
    let cur: string | null | undefined = id;
    // 最大 100 階層を上限に設定（循環参照の防波堤）
    for (let i = 0; i < 100 && cur; i++) {
      const w = wpById.get(cur);
      if (!w || w.parentTaskId === null) break;
      cur = w.parentTaskId;
      d++;
    }
    return d;
  };

  // 深度降順 (深い WP を先に集計 → 親が読む時点で子 WP は最新)
  const sortedWps = [...wps].sort((a, b) => depthOf(b.id) - depthOf(a.id));

  // 各 WP の集計結果をメモリ保持。親は子 WP の **集計後の値** を参照する (DB の古い値ではなく)。
  const aggById = new Map<string, WpAggregationResult>();
  const pendingUpdates: { id: string; agg: WpAggregationResult }[] = [];

  for (const wp of sortedWps) {
    const children = childrenByParent.get(wp.id) ?? [];
    const aggChildren: WpAggregationChild[] = children.map((c) => {
      // 子 WP は既に集計済み (深度降順保証) の最新値を使う
      const childAgg = c.type === 'work_package' ? aggById.get(c.id) : undefined;
      if (childAgg) {
        return {
          plannedEffort: childAgg.plannedEffort,
          progressRate: childAgg.progressRate,
          plannedStartDate: childAgg.plannedStartDate,
          plannedEndDate: childAgg.plannedEndDate,
          actualStartDate: childAgg.actualStartDate,
          actualEndDate: childAgg.actualEndDate,
          status: childAgg.status,
          assigneeId: childAgg.assigneeId,
        };
      }
      // ACT はそのまま DB 値で集計
      return {
        plannedEffort: c.plannedEffort,
        progressRate: c.progressRate,
        plannedStartDate: c.plannedStartDate,
        plannedEndDate: c.plannedEndDate,
        actualStartDate: c.actualStartDate,
        actualEndDate: c.actualEndDate,
        status: c.status,
        assigneeId: c.assigneeId,
      };
    });

    const aggregated = aggregateWpFromChildren(aggChildren);
    aggById.set(wp.id, aggregated);

    // C 案: 現在値と一致するなら update 不要
    if (!isWpAggregationEqual(wp, aggregated)) {
      pendingUpdates.push({ id: wp.id, agg: aggregated });
    }
  }

  // 変更のある WP のみ $transaction 配列形でチャンク一括 update (round-trip を定数化)
  const RECALC_UPDATE_CHUNK = 100;
  for (let i = 0; i < pendingUpdates.length; i += RECALC_UPDATE_CHUNK) {
    const chunk = pendingUpdates.slice(i, i + RECALC_UPDATE_CHUNK);
    await prisma.$transaction(
      chunk.map(({ id, agg }) => {
        // assignee はリレーション経由で更新 (Prisma の update は scalar FK を直書きできない場合がある)
        const { assigneeId, ...rest } = agg;
        return prisma.task.update({
          where: { id },
          data: {
            ...rest,
            assignee: assigneeId ? { connect: { id: assigneeId } } : { disconnect: true },
          },
        });
      }),
    );
  }

  return { total: wps.length, updated: pendingUpdates.length };
}

/**
 * ADR-0035 (2026-06-05): 指定した親 WP 群「とその祖先チェーン」だけを、重複なく深度降順で
 * 1 回ずつ再計算する。一括更新 (bulkUpdateTasks) の再計算用。
 *
 * 旧実装は `for (parentId of uniqueParentIds) await recalculateAncestors(parentId)` と、
 * 親ごとにルートまで再帰していた。これは (a) 共有祖先 (例: 共通ルート) を親の数だけ再 update し、
 * (b) 横広な更新 (多数の別 WP にまたがる) でユニーク親数 × 深さの逐次往復になりタイムアウトに迫る。
 *
 * 本関数は「影響を受ける WP 集合 = 親 ∪ その祖先」を 1 回の findMany (id + parentTaskId のみ) から
 * メモリ上で構築し、深度降順 (子から先) で各 WP をちょうど 1 回 `recalculateWpOnly` する。
 * - `recalculateAllProjectWps` と違い**プロジェクト全 WP は走査しない** (狭い更新が巨大プロジェクトで
 *   O(全WP) に退行するのを防ぐ)。
 * - 共有祖先を 1 回しか再計算しない (旧ループの重複 update を排除)。
 * 最終的な WP 集計値は旧ループと同一 (= 親と全祖先を正しい子集合から再集計した値)。
 */
async function recalculateAffectedWps(
  projectId: string,
  viewerTenantId: string,
  parentIds: string[],
): Promise<void> {
  if (parentIds.length === 0) return;

  const wps = await prisma.task.findMany({
    where: {
      projectId,
      type: 'work_package',
      deletedAt: null,
      project: { tenantId: viewerTenantId },
    },
    select: { id: true, parentTaskId: true },
  });
  if (wps.length === 0) return;

  const byId = new Map(wps.map((w) => [w.id, w]));

  // 影響を受ける WP 集合 = 各 parentId とその祖先チェーン (共有祖先は 1 回だけ収集)
  const affected = new Set<string>();
  for (const pid of parentIds) {
    let cur: string | null | undefined = pid;
    for (let i = 0; i < 100 && cur; i++) {
      if (!byId.has(cur)) break; // WP でない (ありえないが保険) → そのチェーンは打ち切り
      if (affected.has(cur)) break; // 既に収集済 = 以降の祖先も収集済なので打ち切り
      affected.add(cur);
      cur = byId.get(cur)!.parentTaskId;
    }
  }

  const depthOf = (id: string): number => {
    let d = 0;
    let cur: string | null | undefined = id;
    for (let i = 0; i < 100 && cur; i++) {
      const w = byId.get(cur);
      if (!w || w.parentTaskId === null) break;
      cur = w.parentTaskId;
      d++;
    }
    return d;
  };

  // 深度降順 (子 WP を先に再計算 → 親が再集計する時点で子は最新)
  const sorted = [...affected].sort((a, b) => depthOf(b) - depthOf(a));
  for (const id of sorted) {
    await recalculateWpOnly(id);
  }
}

/**
 * 子タスクの集合から WP の集計値を算出する pure 関数。
 * DB 非依存なので単体テスト可能。
 *
 * 実績日付（actualStartDate / actualEndDate）も予定日付と同じロジックで集計する：
 * 子の有効な actual 日付のうち最小/最大を採用、すべて null なら null。
 */
export type WpAggregationChild = {
  // DB 由来は Decimal、子 WP の集計結果を親へ渡す経路では number。
  // aggregateWpFromChildren は Number() で正規化するため両方を受ける。
  plannedEffort: Prisma.Decimal | number;
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

  // ADR-0035 (2026-06-05): C 案 (recalculateWpOnly / recalculateAllProjectWps と同じ最適化)。
  //   集計値が現在値と一致するなら自身の update をスキップし、上位への伝播も止める。
  //   この WP の集計が変わらない = 親が集計する値も変わらないため、祖先も再計算不要 (安全な早期終了)。
  //   旧実装は祖先を無条件 update + 必ずルートまで再帰しており、変化のない祖先にも write が走っていた。
  if (isWpAggregationEqual(task, aggregated)) {
    return;
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

export async function getProgressLogs(
  taskId: string,
  viewerTenantId: string,
): Promise<ProgressLogDTO[]> {
  // 2026-05-09 feedback Phase 2: 越境進捗ログ閲覧を遮断するため task の project tenant 検証。
  const owned = await prisma.task.findFirst({
    where: { id: taskId, deletedAt: null, project: { tenantId: viewerTenantId } },
    select: { id: true },
  });
  if (!owned) return []; // 越境時は空配列 (情報漏洩防止)

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
 * WBS CSV ヘッダー定義 (T-19 で 7 列に集約、PR-ζ の 17 列から削減)
 *
 * 列構成 (項目 15 仕様 + level 1 列):
 *   1. ID         — 突合キー (空欄=新規作成、既存=UPDATE)
 *   2. 種別        — WP / ACT
 *   3. 名称        — タスク名
 *   4. レベル       — 階層位置 (1 始まり、行順と組み合わせて parent 解決)
 *   5. 予定開始日   — ACT のみ反映、WP は空欄
 *   6. 予定終了日   — 同上
 *   7. 予定工数     — 同上
 *
 * 担当者 / 優先度 / マイルストーン / 備考 / WBS 番号 / 進捗系列は CSV 経由で扱わず、
 * UI 側から個別編集する運用に集約 (CSV 編集を「計画調整」用途に限定)。
 */
export const WBS_CSV_HEADERS = [
  'ID', '種別', '名称', 'レベル', '予定開始日', '予定終了日', '予定工数', '土日祝日を含める',
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

/** CSV 行をパース（ダブルクォート対応）。
 *
 *  ⚠️ 本関数は **改行を含まない 1 物理行** 専用。クォート内に改行 (例: `"line1\nline2"`)
 *  を含む multi-line cell は扱えない。CSV 全文を行ごとに先割りしてから本関数に渡すと、
 *  クォート内改行が分断されて 2 行目以降が silent に欠落する (= 旧 sync-import 経路で
 *  発生したデータロス事故、fix/csv-import-multiline-text-data-loss 参照)。
 *
 *  CSV 全文をパースする場合は必ず [[parseCsvText]] を使用すること。
 */
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

/** RFC 4180 準拠 CSV テキストパーサ (multi-line cell 対応)。
 *
 *  [[parseCsvLine]] + `split(/\r?\n/)` 組み合わせの代替。クォート内改行
 *  (例: `"line1\nline2"`) を含むセルを正しく 1 フィールドとして保持する。
 *
 *  挙動:
 *    - UTF-8 BOM 自動除去
 *    - 完全な空行スキップ
 *    - 行ごとの列数違いを許容 (`relax_column_count: true`)
 *    - 各セルの trim は呼出側で実施 (`trim: false`)
 *
 *  @returns 行 × フィールドの 2 次元配列。header 行も含む (呼出側で `slice(1)` する)
 */
export function parseCsvText(csvText: string): string[][] {
  if (!csvText || csvText.length === 0) return [];
  return parseCsvSync(csvText, {
    columns: false,
    skip_empty_lines: true,
    bom: true,
    relax_column_count: true,
    trim: false,
  }) as string[][];
}

/**
 * WBS を 7 列 CSV でエクスポート (T-19 で 17 列から削減)。
 *
 * 列構成:
 *   ID / 種別 / 名称 / レベル / 予定開始日 / 予定終了日 / 予定工数
 *
 * 階層は「レベル」列 (1 始まり) と行の並び順で表現。
 * 担当者 / 優先度 / マイルストーン / 備考 / WBS 番号 / 進捗系列は出力しない
 * (CSV 編集の用途を「計画調整」に絞る)。
 */
export async function exportWbs(
  projectId: string,
  viewerTenantId: string,
  taskIds?: string[],
): Promise<string> {
  // 2026-05-09 feedback Phase 2: 越境エクスポートを遮断するため project tenant フィルタを併記。
  const where: Prisma.TaskWhereInput = {
    projectId,
    deletedAt: null,
    project: { tenantId: viewerTenantId },
  };
  if (taskIds && taskIds.length > 0) {
    where.id = { in: taskIds };
  }

  const tasks = await prisma.task.findMany({
    where,
    orderBy: [{ plannedStartDate: 'asc' }, { createdAt: 'asc' }],
  });

  const taskIdSet = new Set(tasks.map((t) => t.id));

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

  const rootTasks = tasks.filter((t) => !t.parentTaskId || !taskIdSet.has(t.parentTaskId));
  for (const root of rootTasks) {
    if (visited.has(root.id)) continue;
    visited.add(root.id);
    rows.push({ level: 1, task: root });
    walkTree(root.id);
  }

  const lines = [WBS_CSV_HEADERS.join(',')];
  for (const { level, task: t } of rows) {
    const line = [
      t.id,
      t.type === 'work_package' ? 'WP' : 'ACT',
      escapeCsvField(t.name),
      String(level),
      safeDate(t.plannedStartDate) ?? '',
      safeDate(t.plannedEndDate) ?? '',
      String(Number(t.plannedEffort)),
      String(t.includeWeekends),
    ].join(',');
    lines.push(line);
  }
  // BOM 付きで返す (Excel 対応)
  return '﻿' + lines.join('\n');
}

