import type { TaskDTO } from '@/services/task.service';

/** 担当者未設定のタスクを表すフィルタ用センチネル */
export const UNASSIGNED_KEY = '__unassigned__';

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
