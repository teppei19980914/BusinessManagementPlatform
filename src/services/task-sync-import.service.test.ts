import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  prisma: {
    task: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
}));

// task.service の recalculateAncestorsPublic は applySyncImport の最後で呼ばれる。
// 単体テストでは実 DB を伴わない no-op に差し替える。
vi.mock('./task.service', async () => {
  const actual = await vi.importActual<typeof import('./task.service')>('./task.service');
  return {
    ...actual,
    recalculateAncestorsPublic: vi.fn().mockResolvedValue(undefined),
  };
});

import {
  parseSyncImportCsv,
  computeSyncDiff,
} from './task-sync-import.service';
import { prisma } from '@/lib/db';

// T-19 で 7 列に削減: ID / 種別 / 名称 / レベル / 予定開始日 / 予定終了日 / 予定工数
const HEADER_7 = 'ID,種別,名称,レベル,予定開始日,予定終了日,予定工数';

// ============================================================
// parseSyncImportCsv (T-19, 7 列)
// ============================================================

describe('parseSyncImportCsv (T-19)', () => {
  it('ヘッダーのみは空配列を返す', () => {
    expect(parseSyncImportCsv(HEADER_7)).toEqual([]);
  });

  it('ID あり行は id を文字列で持ち、空欄は null になる', () => {
    const csv = [
      HEADER_7,
      'abc-123,WP,設計,1,,,0',
      ',ACT,要件ヒアリング,2,2026-05-01,2026-05-10,5',
    ].join('\n');

    const rows = parseSyncImportCsv(csv);
    expect(rows).toHaveLength(2);
    expect(rows[0].id).toBe('abc-123');
    expect(rows[0].type).toBe('work_package');
    expect(rows[0].name).toBe('設計');
    expect(rows[0].level).toBe(1);
    expect(rows[1].id).toBe(null);
    expect(rows[1].type).toBe('activity');
    expect(rows[1].name).toBe('要件ヒアリング');
    expect(rows[1].level).toBe(2);
    expect(rows[1].plannedStartDate).toBe('2026-05-01');
    expect(rows[1].plannedEndDate).toBe('2026-05-10');
    expect(rows[1].plannedEffort).toBe(5);
  });

  it('BOM 付きでも先頭文字を読み飛ばしてパースできる', () => {
    const bom = '﻿';
    const csv = bom + [HEADER_7, ',WP,A,1,,,0'].join('\n');
    const rows = parseSyncImportCsv(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('A');
  });

  it('予定工数が空欄なら null', () => {
    const csv = [HEADER_7, ',WP,A,1,,,'].join('\n');
    const rows = parseSyncImportCsv(csv);
    expect(rows[0].plannedEffort).toBe(null);
  });

  it('レベルが数値変換できない行はスキップされる', () => {
    const csv = [HEADER_7, ',WP,有効,1,,,0', ',WP,無効,abc,,,0'].join('\n');
    const rows = parseSyncImportCsv(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('有効');
  });

  it('名称が空欄の行はスキップされる', () => {
    const csv = [HEADER_7, ',WP,,1,,,0', ',WP,有効,1,,,0'].join('\n');
    const rows = parseSyncImportCsv(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('有効');
  });
});

// ============================================================
// computeSyncDiff (T-19, 7 列)
// ============================================================

const projectId = 'proj-1';

const baseDbTask = {
  id: 'db-1',
  projectId,
  parentTaskId: null,
  type: 'work_package',
  wbsNumber: '1.0',
  name: '設計',
  description: null,
  category: 'other',
  assigneeId: null,
  plannedStartDate: null,
  plannedEndDate: null,
  actualStartDate: null,
  actualEndDate: null,
  plannedEffort: 0,
  priority: null,
  status: 'not_started',
  progressRate: 0,
  isMilestone: false,
  notes: null,
  createdBy: 'u-A',
  updatedBy: 'u-A',
};

function csvRow(overrides: Record<string, unknown> = {}) {
  return {
    tempRowIndex: 2,
    id: null,
    level: 1,
    type: 'work_package',
    name: '設計',
    plannedStartDate: null,
    plannedEndDate: null,
    plannedEffort: null,
    ...overrides,
  } as Parameters<typeof computeSyncDiff>[1][number];
}

describe('computeSyncDiff (T-19)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('空の CSV はグローバルエラー + canExecute=false', async () => {
    vi.mocked(prisma.task.findMany).mockResolvedValue([] as never);

    const r = await computeSyncDiff(projectId, []);
    expect(r.canExecute).toBe(false);
    expect(r.globalErrors.length).toBeGreaterThan(0);
  });

  it('500 件超は globalError', async () => {
    vi.mocked(prisma.task.findMany).mockResolvedValue([] as never);
    const rows = Array.from({ length: 501 }, (_, i) => csvRow({ tempRowIndex: i + 2, name: `t${i}` }));
    const r = await computeSyncDiff(projectId, rows);
    expect(r.canExecute).toBe(false);
    expect(r.globalErrors[0]).toContain('500 件');
  });

  it('ID 空欄 + DB に同名タスクなし → CREATE 扱い (エラーなし)', async () => {
    vi.mocked(prisma.task.findMany).mockResolvedValue([] as never);

    const r = await computeSyncDiff(projectId, [csvRow({ name: '新規タスク' })]);
    expect(r.canExecute).toBe(true);
    expect(r.summary.added).toBe(1);
    expect(r.rows[0].action).toBe('CREATE');
    expect(r.rows[0].errors).toBeUndefined();
  });

  it('ID 空欄 + DB に同名タスクあり → blocker (誤コピー検知)', async () => {
    vi.mocked(prisma.task.findMany).mockResolvedValue([baseDbTask] as never);

    const r = await computeSyncDiff(projectId, [csvRow({ name: '設計' })]);
    expect(r.canExecute).toBe(false);
    expect(r.rows[0].errors?.[0]).toContain('ID 空欄ですが同名のタスクが既存');
  });

  it('ID 一致 → UPDATE、変更がなければ NO_CHANGE', async () => {
    vi.mocked(prisma.task.findMany).mockResolvedValue([baseDbTask] as never);

    const r = await computeSyncDiff(projectId, [
      csvRow({ id: 'db-1', name: '設計' }),
    ]);
    expect(r.canExecute).toBe(true);
    expect(r.rows[0].action).toBe('NO_CHANGE');
  });

  it('ID 一致 + 名称変更 → UPDATE + fieldChanges', async () => {
    vi.mocked(prisma.task.findMany).mockResolvedValue([baseDbTask] as never);

    const r = await computeSyncDiff(projectId, [
      csvRow({ id: 'db-1', name: '設計フェーズ' }),
    ]);
    expect(r.summary.updated).toBe(1);
    expect(r.rows[0].action).toBe('UPDATE');
    expect(r.rows[0].fieldChanges?.[0]).toMatchObject({ field: 'name', before: '設計', after: '設計フェーズ' });
  });

  it('ID が DB に存在しない → blocker', async () => {
    vi.mocked(prisma.task.findMany).mockResolvedValue([] as never);

    const r = await computeSyncDiff(projectId, [csvRow({ id: 'unknown-id', name: 'X' })]);
    expect(r.canExecute).toBe(false);
    expect(r.rows[0].errors?.[0]).toContain('ID "unknown-id" が DB に存在しません');
  });

  it('WP↔ACT 切替は blocker', async () => {
    vi.mocked(prisma.task.findMany).mockResolvedValue([baseDbTask] as never); // 既存は WP

    const r = await computeSyncDiff(projectId, [
      csvRow({ id: 'db-1', name: '設計', type: 'activity' }),
    ]);
    expect(r.canExecute).toBe(false);
    expect(r.rows[0].errors?.some((e) => e.includes('種別'))).toBe(true);
  });

  it('CSV 内 ID 重複は blocker', async () => {
    vi.mocked(prisma.task.findMany).mockResolvedValue([baseDbTask, { ...baseDbTask, id: 'db-2', name: '別' }] as never);

    const r = await computeSyncDiff(projectId, [
      csvRow({ id: 'db-1', name: '設計', tempRowIndex: 2 }),
      csvRow({ id: 'db-1', name: '設計2', tempRowIndex: 3 }),
    ]);
    expect(r.canExecute).toBe(false);
    expect(r.rows[0].errors?.some((e) => e.includes('CSV 内で ID'))).toBe(true);
  });

  it('CSV から消えたタスク → REMOVE_CANDIDATE 行を追加', async () => {
    vi.mocked(prisma.task.findMany).mockResolvedValue([
      baseDbTask,
      { ...baseDbTask, id: 'db-2', name: 'もう必要ないタスク', progressRate: 0, actualStartDate: null },
    ] as never);

    const r = await computeSyncDiff(projectId, [
      csvRow({ id: 'db-1', name: '設計' }),
    ]);
    const removeRow = r.rows.find((row) => row.action === 'REMOVE_CANDIDATE');
    expect(removeRow).toBeDefined();
    expect(removeRow?.name).toBe('もう必要ないタスク');
    expect(removeRow?.hasProgress).toBe(false);
  });

  it('進捗ありタスクの REMOVE_CANDIDATE は ERROR レベル', async () => {
    vi.mocked(prisma.task.findMany).mockResolvedValue([
      baseDbTask,
      { ...baseDbTask, id: 'db-2', name: '進捗あり', progressRate: 50, actualStartDate: new Date() },
    ] as never);

    const r = await computeSyncDiff(projectId, [
      csvRow({ id: 'db-1', name: '設計' }),
    ]);
    const removeRow = r.rows.find((row) => row.action === 'REMOVE_CANDIDATE');
    expect(removeRow?.hasProgress).toBe(true);
    expect(removeRow?.warningLevel).toBe('ERROR');
  });
});
