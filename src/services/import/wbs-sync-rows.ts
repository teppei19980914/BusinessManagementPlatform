/**
 * 外部移行インポート — WbsRow → SyncImportRow 変換 (ADR-0034 §7)
 *
 * wbs-hierarchy が出力した前順序 + レベルの WbsRow を、既存 WBS 取り込み
 * (applySyncImport) が受け取る SyncImportRow に変換する。全行 CREATE (id=null)。
 * parentRowIndex は level スタックから決定 (既存 parseSyncImportCsv と同じロジック)。
 */

import type { SyncImportRow } from '../task-sync-import.service';
import type { WbsRow } from './wbs-hierarchy';

export function toSyncImportRows(wbs: WbsRow[]): SyncImportRow[] {
  // stack[level-1] = その level の直近行の tempRowIndex
  const stack: number[] = [];
  return wbs.map((row, i) => {
    const tempRowIndex = i + 1;
    const parentRowIndex = row.level > 1 ? (stack[row.level - 2] ?? null) : null;
    stack[row.level - 1] = tempRowIndex;
    stack.length = row.level; // 深いレベルのスタックを破棄
    return {
      tempRowIndex,
      id: null, // 全行 CREATE
      level: row.level,
      type: row.type,
      name: row.name,
      plannedStartDate: row.plannedStartDate,
      plannedEndDate: row.plannedEndDate,
      plannedEffort: row.plannedEffort,
      includeWeekends: false,
      parentRowIndex,
    };
  });
}
