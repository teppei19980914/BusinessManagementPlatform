/**
 * 外部移行インポート — WBS 階層の正規化 (ADR-0034 §7)
 *
 * 役割:
 *   外部ソースの「親子つき WBS ノード列」を、たすきばの既存 WBS 取り込み
 *   ([task-sync-import.service.ts]) が理解できる「前順序 (親が子より先) + レベル (深さ)」へ変換する。
 *
 * 規則:
 *   - WP/ACT は構造ベースで判定: 子を持つ枝 = work_package、子を持たない葉 = activity。
 *     これにより「ACT は WP 配下」制約が自動的に満たされる (ソース側の種別は使わない)。
 *   - 並びは深さ優先・前順序 (DFS preorder)。API は順不同で返るため必ず並べ直す。
 *   - WP に実績 (予定日/工数) が付いていても、たすきば WP は子から自動計算するため捨てる
 *     (ADR-0034: 親タスクの実績は警告して捨てる)。
 *   - 親が見つからないノード (orphan) はルート扱い + 警告。循環は検出して打ち切り + 警告。
 *
 * 純関数。DB アクセスや副作用は持たない (単体テスト容易)。
 */

export interface SourceWbsNode {
  /** ソース側の安定 ID (Notion page id / Backlog issueId / 親参照のキー) */
  sourceId: string;
  /** 親ノードの sourceId。ルートは null */
  parentSourceId: string | null;
  name: string;
  /** ACT のみ意味を持つ。WP では捨てられる */
  plannedStartDate?: string | null;
  plannedEndDate?: string | null;
  plannedEffort?: number | null;
}

export interface WbsRow {
  level: number; // ルート = 1
  type: 'work_package' | 'activity';
  name: string;
  plannedStartDate: string | null;
  plannedEndDate: string | null;
  plannedEffort: number | null;
  sourceId: string;
}

export interface WbsConversionResult {
  rows: WbsRow[];
  warnings: string[];
}

/**
 * 親子つきノード列を前順序 + レベルの WbsRow 列へ変換する。
 */
export function convertToWbsRows(nodes: SourceWbsNode[]): WbsConversionResult {
  const warnings: string[] = [];
  const rows: WbsRow[] = [];

  if (nodes.length === 0) {
    return { rows, warnings };
  }

  // sourceId → ノード (重複 ID は最初を採用 + 警告)
  const byId = new Map<string, SourceWbsNode>();
  for (const n of nodes) {
    if (byId.has(n.sourceId)) {
      warnings.push(`ソース ID「${n.sourceId}」が重複しています。最初の行を採用します。`);
      continue;
    }
    byId.set(n.sourceId, n);
  }

  // 親 sourceId → 子ノード列 (入力順を維持)。親が存在しないものはルートへ。
  const childrenOf = new Map<string | null, SourceWbsNode[]>();
  const pushChild = (parentKey: string | null, node: SourceWbsNode) => {
    const arr = childrenOf.get(parentKey) ?? [];
    arr.push(node);
    childrenOf.set(parentKey, arr);
  };

  for (const n of nodes) {
    if (!byId.has(n.sourceId)) continue; // 重複でスキップされたノード
    const parentKey = n.parentSourceId;
    if (parentKey != null && !byId.has(parentKey)) {
      // 親が見つからない → ルート扱い + 警告
      warnings.push(`「${n.name}」の親 (ID: ${parentKey}) が見つかりません。最上位として取り込みます。`);
      pushChild(null, n);
    } else {
      pushChild(parentKey, n);
    }
  }

  const hasChildren = (sourceId: string): boolean => (childrenOf.get(sourceId)?.length ?? 0) > 0;

  const visited = new Set<string>();

  const walk = (node: SourceWbsNode, level: number, path: Set<string>): void => {
    if (path.has(node.sourceId)) {
      warnings.push(`「${node.name}」で循環参照を検出したため、このノード以下を打ち切ります。`);
      return;
    }
    if (visited.has(node.sourceId)) {
      return;
    }
    visited.add(node.sourceId);

    const isWp = hasChildren(node.sourceId);
    if (isWp && (node.plannedStartDate || node.plannedEndDate || node.plannedEffort != null)) {
      warnings.push(
        `「${node.name}」は子を持つためワークパッケージになります。予定日・工数は子から自動計算されるため取り込みません。`,
      );
    }

    rows.push({
      level,
      type: isWp ? 'work_package' : 'activity',
      name: node.name,
      plannedStartDate: isWp ? null : (node.plannedStartDate ?? null),
      plannedEndDate: isWp ? null : (node.plannedEndDate ?? null),
      plannedEffort: isWp ? null : (node.plannedEffort ?? null),
      sourceId: node.sourceId,
    });

    const nextPath = new Set(path);
    nextPath.add(node.sourceId);
    for (const child of childrenOf.get(node.sourceId) ?? []) {
      walk(child, level + 1, nextPath);
    }
  };

  for (const root of childrenOf.get(null) ?? []) {
    walk(root, 1, new Set());
  }

  // 循環などで未訪問のまま残ったノードを救済 (ルート扱い + 警告)
  for (const n of nodes) {
    if (byId.has(n.sourceId) && !visited.has(n.sourceId)) {
      warnings.push(`「${n.name}」は循環参照のため到達できませんでした。最上位として取り込みます。`);
      walk(n, 1, new Set());
    }
  }

  return { rows, warnings };
}
