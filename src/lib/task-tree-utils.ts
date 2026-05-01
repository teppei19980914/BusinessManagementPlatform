import type { TaskDTO } from '@/services/task.service';

/** 担当者未設定のタスクを表すフィルタ用センチネル */
export const UNASSIGNED_KEY = '__unassigned__';

/**
 * タスク状況 (TaskStatus) に対応する Badge バリアント (PR #63 共通化)。
 * WBS / ガント / マイタスクで同じ配色を使うため一元化した。
 */
export const taskStatusColors: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  not_started: 'outline',
  in_progress: 'default',
  completed: 'secondary',
  on_hold: 'destructive',
};

/**
 * 担当者 (assigneeId) の選択セットに基づきタスクツリーをフィルタする。
 * - タスク自身の担当者が選択セットに含まれる: 残す
 * - 自身は非該当だが子孫が残っている: 親 WP として階層を失わないよう残す
 * - どちらでもない: 除外
 * 未アサイン (assigneeId が null/undefined) は UNASSIGNED_KEY で表現する。
 */
export function filterTreeByAssignee(nodes: TaskDTO[], selected: Set<string>): TaskDTO[] {
  const result: TaskDTO[] = [];
  for (const node of nodes) {
    const childrenFiltered
      = node.children && node.children.length > 0
        ? filterTreeByAssignee(node.children, selected)
        : undefined;
    const key = node.assigneeId ?? UNASSIGNED_KEY;
    const selfMatch = selected.has(key);
    const hasFilteredChildren = !!childrenFiltered && childrenFiltered.length > 0;
    if (selfMatch || hasFilteredChildren) {
      result.push({ ...node, children: childrenFiltered });
    }
  }
  return result;
}

/**
 * 状況 (status) の選択セットに基づきタスクツリーをフィルタする (PR #61)。
 * - タスク自身の status が選択セットに含まれる: 残す
 * - 自身は非該当だが子孫が残っている: 親 WP として階層を失わないよう残す
 * - 子を持たない WP は status フィルタの対象外とし、selected が空でない限り残す
 *   (WP は子 ACT を持つのが本来の姿なので特殊扱いは行わない方針)
 */
export function filterTreeByStatus(nodes: TaskDTO[], selected: Set<string>): TaskDTO[] {
  const result: TaskDTO[] = [];
  for (const node of nodes) {
    const childrenFiltered
      = node.children && node.children.length > 0
        ? filterTreeByStatus(node.children, selected)
        : undefined;
    const selfMatch = selected.has(node.status);
    const hasFilteredChildren = !!childrenFiltered && childrenFiltered.length > 0;
    if (selfMatch || hasFilteredChildren) {
      result.push({ ...node, children: childrenFiltered });
    }
  }
  return result;
}

/** ツリーから全 ID を再帰的に収集する */
export function collectAllIds(nodes: TaskDTO[]): string[] {
  const ids: string[] = [];
  for (const node of nodes) {
    ids.push(node.id);
    if (node.children) {
      ids.push(...collectAllIds(node.children));
    }
  }
  return ids;
}

/**
 * 指定 ID のノードと、その全子孫（子 WP + 子 ACT + 孫以降）の ID 配列を返す。
 * 見つからなければ空配列。
 * 親 WP チェック → 子孫一括チェックのカスケード選択などに使う。
 */
export function collectSelfAndDescendantIds(nodes: TaskDTO[], targetId: string): string[] {
  for (const node of nodes) {
    if (node.id === targetId) {
      return [node.id, ...(node.children ? collectAllIds(node.children) : [])];
    }
    if (node.children) {
      const found = collectSelfAndDescendantIds(node.children, targetId);
      if (found.length > 0) return found;
    }
  }
  return [];
}

/**
 * 指定 ID のノードに到達するまでの **祖先 (parent → grandparent → ...) の ID 配列** を返す。
 * 自身は含まない。見つからなければ空配列。
 *
 * 用途: 通知 deep link で `?taskId=xxx` を踏んだ際、該当タスクが折りたたみ階層内に
 *      隠れている場合に親 WP を全展開して可視にする (PR feat/notification-deep-link-completion)。
 *
 * 例:
 *   tree: [{ id: 'root', children: [{ id: 'mid', children: [{ id: 'leaf' }] }] }]
 *   findAncestorIds(tree, 'leaf') → ['root', 'mid']
 *   findAncestorIds(tree, 'root') → []           (祖先なし)
 *   findAncestorIds(tree, 'unknown') → []        (見つからない)
 */
export function findAncestorIds(nodes: TaskDTO[], targetId: string): string[] {
  function walk(currentNodes: TaskDTO[], path: string[]): string[] | null {
    for (const node of currentNodes) {
      if (node.id === targetId) {
        return path; // path は親祖先のみ (自身を除く)
      }
      if (node.children && node.children.length > 0) {
        const found = walk(node.children, [...path, node.id]);
        if (found !== null) return found;
      }
    }
    return null;
  }
  return walk(nodes, []) ?? [];
}

/**
 * ツリー構造から `id` で再帰的にタスクを探す。
 * tasks-client.tsx の `tasks: TaskDTO[]` (root 配列、各 root の `children` で階層) で使う。
 */
export function findTaskInTree(nodes: TaskDTO[], targetId: string): TaskDTO | null {
  for (const node of nodes) {
    if (node.id === targetId) return node;
    if (node.children) {
      const found = findTaskInTree(node.children, targetId);
      if (found) return found;
    }
  }
  return null;
}
