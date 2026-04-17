import type { TaskDTO } from '@/services/task.service';

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
