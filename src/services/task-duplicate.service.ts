/**
 * WBS タスク一括複製サービス (PR #420 スコープ追加, 2026-05-25)。
 *
 * 役割:
 *   WBS 一覧でチェック ON のタスクを「target parent (= 任意 WP or root)」配下に
 *   そのままの構造で複製する。インポート手順を経ずに画面上で複数作成する導線。
 *
 * 主な動作:
 *   - **階層保持**: 選択範囲内の親子関係は維持。選択外を親とするタスクは target parent 直下に。
 *   - **計画情報コピー / 実績情報リセット**: 名称・日付・工数・担当者・備考 等はコピー。
 *     status='not_started', progressRate=0, actualStartDate/EndDate=null にリセット。
 *   - **名称衝突は自動リネーム**: "(コピー)", "(コピー 2)", "(コピー 3)" の suffix で解消。
 *   - **WP/ACT 構造ルール強制**: ACT は WP の配下にのみ作成可。target parent が null または
 *     ACT の場合、選択された ACT を root or ACT 配下にはできない。
 *   - **テナント越境防止**: projectId のテナント所属確認 + selected tasks の同 project 確認。
 *
 * 設計判断:
 *   - PgBouncer 制約で $transaction 不可なので逐次 create + 失敗時は呼出側で snapshot rollback の
 *     代替が無い (= 部分成功の可能性あり)。ただし duplicate は新規 INSERT のみで既存破壊なしのため
 *     部分成功は許容範囲 (失敗 task 以降は作られないだけで、既存 WBS は無傷)。
 *   - 上限 100 件 (既存 bulk-edit と同じ)。
 *
 * 関連:
 *   - src/app/api/projects/[projectId]/tasks/bulk-duplicate/route.ts
 *   - src/services/task.service.ts (recalculateAncestorsPublic)
 *   - PR #420 #C3: (project_id, parent_task_id, name) 部分 UNIQUE インデックス
 *     (= 名称衝突は DB 制約でも防御。app 層リネームを通れば DB 制約も通る前提)
 */

import { prisma } from '@/lib/db';
import { recalculateAncestorsPublic } from './task.service';

export type DuplicateTasksInput = {
  projectId: string;
  taskIds: string[];
  /** null = root level */
  targetParentId: string | null;
  userId: string;
  viewerTenantId: string;
};

export type DuplicateTasksResult = {
  added: number;
  createdIds: string[];
  /** "(コピー)" suffix で改名された件数 */
  renamedCount: number;
};

export const MAX_DUPLICATE_AT_ONCE = 100;

type SourceTask = {
  id: string;
  projectId: string;
  parentTaskId: string | null;
  type: string;
  wbsNumber: string | null;
  name: string;
  description: string | null;
  category: string;
  assigneeId: string | null;
  plannedStartDate: Date | null;
  plannedEndDate: Date | null;
  // Prisma Decimal は unknown で受けて Number 変換時に Decimal を許容
  plannedEffort: unknown;
  priority: string | null;
  isMilestone: boolean;
  notes: string | null;
};

/**
 * 一括複製の入口。validation → 親解決 → リネーム → 逐次 INSERT → WP 集計再計算。
 *
 * @throws Error('PROJECT_NOT_FOUND')
 * @throws Error('TASKS_OUT_OF_RANGE') 件数が 1-100 外
 * @throws Error('TASKS_NOT_FOUND:...')  指定 ID の一部が存在しない
 * @throws Error('TASKS_CROSS_PROJECT')  別 project の task が混入
 * @throws Error('TARGET_PARENT_NOT_FOUND')
 * @throws Error('TARGET_PARENT_NOT_WP')  target parent が ACT
 * @throws Error('ACT_CANNOT_BE_ROOT:<names>')  ACT を root or ACT 配下に置こうとした
 */
export async function duplicateTasks(input: DuplicateTasksInput): Promise<DuplicateTasksResult> {
  const { projectId, taskIds, targetParentId, userId, viewerTenantId } = input;

  // -----------------------------------------------------------
  // 1. 件数 validation
  // -----------------------------------------------------------
  if (taskIds.length === 0 || taskIds.length > MAX_DUPLICATE_AT_ONCE) {
    throw new Error('TASKS_OUT_OF_RANGE');
  }

  // -----------------------------------------------------------
  // 2. テナント越境防止: projectId のテナント所属確認
  // -----------------------------------------------------------
  const projectOk = await prisma.project.findFirst({
    where: { id: projectId, tenantId: viewerTenantId, deletedAt: null },
    select: { id: true },
  });
  if (!projectOk) {
    throw new Error('PROJECT_NOT_FOUND');
  }

  // -----------------------------------------------------------
  // 3. 選択 task を取得。
  //   [SEC] projectId を where に含めることで「他プロジェクトの task ID 存在判定」
  //   を timing/error で漏らさない。別 project の task ID は単に missing 扱い。
  // -----------------------------------------------------------
  const sources: SourceTask[] = await prisma.task.findMany({
    where: { id: { in: taskIds }, projectId, deletedAt: null },
    select: {
      id: true,
      projectId: true,
      parentTaskId: true,
      type: true,
      wbsNumber: true,
      name: true,
      description: true,
      category: true,
      assigneeId: true,
      plannedStartDate: true,
      plannedEndDate: true,
      plannedEffort: true,
      priority: true,
      isMilestone: true,
      notes: true,
    },
  });

  if (sources.length !== taskIds.length) {
    const missing = taskIds.filter((id) => !sources.some((s) => s.id === id));
    throw new Error(`TASKS_NOT_FOUND:${missing.join(',')}`);
  }
  // [SEC] 上の projectId フィルタでこの check には到達しない設計だが、defense-in-depth で残す。
  if (sources.some((s) => s.projectId !== projectId)) {
    throw new Error('TASKS_CROSS_PROJECT');
  }

  // -----------------------------------------------------------
  // 4. target parent validation
  // -----------------------------------------------------------
  let targetParent: { id: string; type: string } | null = null;
  if (targetParentId) {
    const tp = await prisma.task.findFirst({
      where: { id: targetParentId, projectId, deletedAt: null },
      select: { id: true, type: true },
    });
    if (!tp) {
      throw new Error('TARGET_PARENT_NOT_FOUND');
    }
    if (tp.type !== 'work_package') {
      throw new Error('TARGET_PARENT_NOT_WP');
    }
    targetParent = tp;
  }

  // -----------------------------------------------------------
  // 5. 階層: 「new parent」を解決
  //   親が選択範囲内なら → そのコピーが new parent
  //   親が選択範囲外なら → targetParent が new parent
  // -----------------------------------------------------------
  const selectedIdSet = new Set(sources.map((s) => s.id));
  type EffectiveParent =
    | { kind: 'target'; id: string | null }
    | { kind: 'selected'; oldId: string };
  const effectiveParentByOldId = new Map<string, EffectiveParent>();
  for (const s of sources) {
    if (s.parentTaskId && selectedIdSet.has(s.parentTaskId)) {
      effectiveParentByOldId.set(s.id, { kind: 'selected', oldId: s.parentTaskId });
    } else {
      effectiveParentByOldId.set(s.id, { kind: 'target', id: targetParentId });
    }
  }

  // -----------------------------------------------------------
  // 6. WP/ACT 構造ルール: ACT は WP の配下のみ
  //   - 選択範囲外を親とする ACT は targetParent が WP でないと不可 (root=null も不可)
  //   - 選択範囲内を親とする ACT は親 (= 選択された source) が WP でないと不可
  // -----------------------------------------------------------
  const actsCannotBeRoot: string[] = [];
  for (const s of sources) {
    if (s.type !== 'activity') continue;
    const ep = effectiveParentByOldId.get(s.id)!;
    if (ep.kind === 'target') {
      if (!targetParent) {
        // target = root のとき ACT は不可
        actsCannotBeRoot.push(s.name);
      }
      // target が WP なのは step 4 で確認済
    } else {
      // 選択範囲内の親
      const parent = sources.find((x) => x.id === ep.oldId)!;
      if (parent.type !== 'work_package') {
        // 親 ACT の配下に子 ACT を作ろうとしている (元の DB でもありえないが防御)
        actsCannotBeRoot.push(s.name);
      }
    }
  }
  if (actsCannotBeRoot.length > 0) {
    throw new Error(`ACT_CANNOT_BE_ROOT:${actsCannotBeRoot.join(', ')}`);
  }

  // -----------------------------------------------------------
  // 7. topological sort: 親→子の順に並べる
  //   = 選択範囲内の root (= 親が選択範囲外) から開始、deep-first で展開
  // -----------------------------------------------------------
  const sortedSources: SourceTask[] = [];
  const visited = new Set<string>();
  const byId = new Map(sources.map((s) => [s.id, s]));
  function visit(t: SourceTask): void {
    if (visited.has(t.id)) return;
    visited.add(t.id);
    const ep = effectiveParentByOldId.get(t.id)!;
    if (ep.kind === 'selected') {
      visit(byId.get(ep.oldId)!);
    }
    sortedSources.push(t);
  }
  for (const s of sources) visit(s);

  // -----------------------------------------------------------
  // 8. 名称衝突解消: new parent ごとに既存タスク名 + 新規予約名を集計し、
  //   "(コピー)" suffix で重複しない名前を割り当てる
  // -----------------------------------------------------------
  // target parent 配下の既存タスク名を一度だけ取得
  const targetExistingNames = await fetchChildrenNames(projectId, targetParentId);
  // namespacedTakenNames[newParentKey] = Set<name>。newParentKey は target は 'target', 内側親はその oldId
  const takenByGroup = new Map<string, Set<string>>();
  takenByGroup.set('target', new Set(targetExistingNames));

  const oldToNewId = new Map<string, string>();
  const oldToNewName = new Map<string, string>();
  let renamedCount = 0;

  for (const s of sortedSources) {
    const ep = effectiveParentByOldId.get(s.id)!;
    const groupKey = ep.kind === 'target' ? 'target' : `selected:${ep.oldId}`;
    if (!takenByGroup.has(groupKey)) {
      // 「選択範囲内の親」の場合、その親の DB の既存子供名は無関係 (親自体が新規)
      takenByGroup.set(groupKey, new Set());
    }
    const taken = takenByGroup.get(groupKey)!;
    const finalName = pickNonConflictingName(s.name, taken);
    if (finalName !== s.name) renamedCount++;
    taken.add(finalName);
    oldToNewName.set(s.id, finalName);
  }

  // -----------------------------------------------------------
  // 9. 逐次 INSERT (sortedSources の順番で親→子)
  // -----------------------------------------------------------
  const createdIds: string[] = [];
  for (const s of sortedSources) {
    const ep = effectiveParentByOldId.get(s.id)!;
    const newParentId =
      ep.kind === 'target' ? ep.id : (oldToNewId.get(ep.oldId) ?? null);
    const newName = oldToNewName.get(s.id)!;

    const isActivity = s.type === 'activity';
    const created = await prisma.task.create({
      data: {
        projectId,
        parentTaskId: newParentId,
        type: s.type,
        name: newName,
        description: s.description,
        category: s.category,
        // 計画情報: コピー
        assigneeId: isActivity ? s.assigneeId : null,
        plannedStartDate: isActivity ? s.plannedStartDate : null,
        plannedEndDate: isActivity ? s.plannedEndDate : null,
        plannedEffort: isActivity ? (Number(s.plannedEffort) || 0) : 0,
        priority: isActivity ? (s.priority ?? 'medium') : null,
        isMilestone: s.isMilestone,
        notes: s.notes,
        // 実績情報: リセット
        status: 'not_started',
        progressRate: 0,
        actualStartDate: null,
        actualEndDate: null,
        createdBy: userId,
        updatedBy: userId,
      },
    });
    oldToNewId.set(s.id, created.id);
    createdIds.push(created.id);
  }

  // -----------------------------------------------------------
  // 10. WP 集計再計算: 影響を受ける全 WP に対して呼ぶ。
  //   - 新規作成された WP 自身 (= 新規 ACT 子を抱える可能性があるため自身の plannedEffort を集計)
  //   - target parent (= 新規子が増えたため再集計が必要)
  //
  //   recalculateAncestors は「ACT 引数では no-op + parent 伝播もしない」仕様なので、
  //   新規 WP 自身を呼ばないと、ACT 子の effort が WP 親の plannedEffort に反映されない。
  //   呼出順は不問 (各呼出が自身を集計 → 親へ伝播するので、どの順でも最終整合する)。
  // -----------------------------------------------------------
  const affectedWpIds = new Set<string>();
  for (const s of sortedSources) {
    if (s.type === 'work_package') {
      const newId = oldToNewId.get(s.id);
      if (newId) affectedWpIds.add(newId);
    }
  }
  if (targetParent) {
    affectedWpIds.add(targetParent.id);
  }
  for (const wpId of affectedWpIds) {
    await recalculateAncestorsPublic(wpId);
  }

  return {
    added: createdIds.length,
    createdIds,
    renamedCount,
  };
}

// ============================================================
// 内部 helper
// ============================================================

/**
 * 指定 parent (null = root) 配下のアクティブな task 名を返す。
 */
async function fetchChildrenNames(projectId: string, parentId: string | null): Promise<string[]> {
  const children = await prisma.task.findMany({
    where: { projectId, parentTaskId: parentId, deletedAt: null },
    select: { name: true },
  });
  return children.map((c) => c.name);
}

/** tasks.name の DB 列幅 (VARCHAR(100))。本 const 以上の長さは INSERT 失敗。 */
const TASK_NAME_MAX_LENGTH = 100;

/**
 * 衝突しない名前を返す。
 * - taken に元の name が無ければそのまま使用
 * - あれば "(コピー)", "(コピー 2)", "(コピー 3)" を順に試す
 *
 * 上限: 連番が 1000 まで行ったら fallback で UUID 断片を付ける (実用上ほぼ起こらない)。
 *
 * [SEC/CORRECTNESS] DB の VARCHAR(100) 制約を超えないよう、suffix を付ける際は
 * base を必要なだけ truncate する (95+ 文字の name でも DB 挿入が失敗しない)。
 */
export function pickNonConflictingName(originalName: string, taken: Set<string>): string {
  if (!taken.has(originalName)) {
    // 元 name 自体が DB 列幅以下である前提 (source は既に DB に存在するため必ず ≤100)
    return originalName;
  }
  function withSuffix(suffix: string): string {
    const maxBase = TASK_NAME_MAX_LENGTH - suffix.length;
    const base = originalName.length > maxBase ? originalName.slice(0, maxBase) : originalName;
    return base + suffix;
  }
  // 1st: " (コピー)"
  const firstCandidate = withSuffix(' (コピー)');
  if (!taken.has(firstCandidate)) return firstCandidate;
  // 2nd onwards: " (コピー N)"
  for (let n = 2; n <= 1000; n++) {
    const candidate = withSuffix(` (コピー ${n})`);
    if (!taken.has(candidate)) return candidate;
  }
  // Fallback (極限ケース)
  return withSuffix(` (コピー ${Math.random().toString(36).slice(2, 8)})`);
}
