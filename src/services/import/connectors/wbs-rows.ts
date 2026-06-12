/**
 * 外部移行インポート — 親子グラフ WBS → 既存CSV経路が食う「レベル列つきフラット行」 (ADR-0034)
 *
 * Notion sub-item relation / Backlog parentIssueId / kintone・Pleasanter の親リンク など、
 * 「各ノードが親を指す」形の WBS を、既存 csv-to-batch の WBS レベル列方式に橋渡しする。
 *
 *   親子グラフ → (convertToWbsRows) → 前順序 + レベルの WbsRow
 *              → レベル列つき CsvRow (projectName/level/name/予定日/工数)
 *
 * これにより API 経路の WBS も、手動CSV経路と**同じ** buildBatchFromCsv に流せる
 * (レベル列を再びスタックで親子復元 → WP/ACT 構造判定。前順序+レベルは木を一意に定めるため等価)。
 *
 * convertToWbsRows が出す警告 (孤児→ルート / 循環打ち切り / WP の予定日・工数破棄) は
 * ここで受け取り、呼出側 (コネクタ) が previewMigrationFromSources の warnings に渡す。
 * 直列化後のレベル行はクリーン (孤児/循環なし) なので buildBatchFromCsv 再変換では警告は出ず重複しない。
 *
 * 純関数。HTTP・DB に触れない。
 */

import { convertToWbsRows, type SourceWbsNode } from '../wbs-hierarchy';
import type { CsvRow } from '../csv-to-batch';

/** WBS レベル列方式の固定列名 (= 既定の columnMap キーと一致)。 */
export const WBS_ROW_COLUMNS = {
  projectName: 'projectName',
  level: 'level',
  name: 'name',
  plannedStartDate: 'plannedStartDate',
  plannedEndDate: 'plannedEndDate',
  plannedEffort: 'plannedEffort',
} as const;

/** {@link wbsNodesToCsvRows} が出す CsvEntitySource 用の恒等 columnMap。 */
export const WBS_ROW_COLUMN_MAP: Record<string, string> = {
  projectName: 'projectName',
  level: 'level',
  name: 'name',
  plannedStartDate: 'plannedStartDate',
  plannedEndDate: 'plannedEndDate',
  plannedEffort: 'plannedEffort',
};

export interface WbsRowsResult {
  rows: CsvRow[];
  warnings: string[];
}

/**
 * 親子グラフ WBS をレベル列つき CsvRow 列へ変換する。各行に projectName を付与する。
 * @param nodes 親子つき WBS ノード列 (順不同で可)
 * @param projectName この WBS 群が属するプロジェクト名 (各行に同じ値を付与)
 */
export function wbsNodesToCsvRows(nodes: SourceWbsNode[], projectName: string): WbsRowsResult {
  const { rows, warnings } = convertToWbsRows(nodes);
  const csvRows: CsvRow[] = rows.map((r) => ({
    projectName,
    level: String(r.level),
    name: r.name,
    plannedStartDate: r.plannedStartDate ?? '',
    plannedEndDate: r.plannedEndDate ?? '',
    plannedEffort: r.plannedEffort != null ? String(r.plannedEffort) : '',
  }));
  return { rows: csvRows, warnings };
}
