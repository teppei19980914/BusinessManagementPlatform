import { describe, it, expect } from 'vitest';
import { toSyncImportRows } from './wbs-sync-rows';
import type { WbsRow } from './wbs-hierarchy';

const wbs: WbsRow[] = [
  { level: 1, type: 'work_package', name: '設計', plannedStartDate: null, plannedEndDate: null, plannedEffort: null, sourceId: 'A' },
  { level: 2, type: 'activity', name: '基本設計', plannedStartDate: '2026-06-01', plannedEndDate: '2026-06-10', plannedEffort: 8, sourceId: 'B' },
  { level: 2, type: 'work_package', name: '詳細設計', plannedStartDate: null, plannedEndDate: null, plannedEffort: null, sourceId: 'C' },
  { level: 3, type: 'activity', name: '画面設計', plannedStartDate: null, plannedEndDate: null, plannedEffort: 4, sourceId: 'D' },
];

describe('toSyncImportRows', () => {
  it('全行 id=null (CREATE)、tempRowIndex 連番', () => {
    const rows = toSyncImportRows(wbs);
    expect(rows.every((r) => r.id === null)).toBe(true);
    expect(rows.map((r) => r.tempRowIndex)).toEqual([1, 2, 3, 4]);
  });

  it('parentRowIndex を level スタックから決定', () => {
    const rows = toSyncImportRows(wbs);
    // 設計(L1)=ルート, 基本設計(L2)親=設計(1), 詳細設計(L2)親=設計(1), 画面設計(L3)親=詳細設計(3)
    expect(rows.map((r) => r.parentRowIndex)).toEqual([null, 1, 1, 3]);
  });

  it('ACT の予定日/工数を引き継ぐ', () => {
    const rows = toSyncImportRows(wbs);
    expect(rows[1]).toMatchObject({ name: '基本設計', plannedStartDate: '2026-06-01', plannedEffort: 8 });
  });
});
