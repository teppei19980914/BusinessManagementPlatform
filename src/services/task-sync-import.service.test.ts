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
    // 2026-05-10 Phase 2-8: 越境 sync-import 遮断のため project の tenant 検証を実施
    project: {
      findFirst: vi.fn(),
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
  applySyncImport,
} from './task-sync-import.service';
import { prisma } from '@/lib/db';

// T-19 で 7 列に削減: ID / 種別 / 名称 / レベル / 予定開始日 / 予定終了日 / 予定工数
const HEADER_7 = 'ID,種別,名称,レベル,予定開始日,予定終了日,予定工数';

// ============================================================
// parseSyncImportCsv (T-19, 7 列)
// ============================================================

describe('parseSyncImportCsv (T-19)', () => {
  it('ヘッダーのみは空配列を返す', () => {
    const r = parseSyncImportCsv(HEADER_7);
    expect(r.rows).toEqual([]);
    expect(r.headerErrors).toEqual([]);
  });

  it('ID あり行は id を文字列で持ち、空欄は null になる', () => {
    const csv = [
      HEADER_7,
      'abc-123,WP,設計,1,,,0',
      ',ACT,要件ヒアリング,2,2026-05-01,2026-05-10,5',
    ].join('\n');

    const { rows, headerErrors } = parseSyncImportCsv(csv);
    expect(headerErrors).toEqual([]);
    expect(rows).toHaveLength(2);
    expect(rows[0].id).toBe('abc-123');
    expect(rows[0].type).toBe('work_package');
    expect(rows[0].name).toBe('設計');
    expect(rows[0].level).toBe(1);
    expect(rows[0].parentRowIndex).toBe(null); // root
    expect(rows[1].id).toBe(null);
    expect(rows[1].type).toBe('activity');
    expect(rows[1].name).toBe('要件ヒアリング');
    expect(rows[1].level).toBe(2);
    expect(rows[1].parentRowIndex).toBe(2); // 1行目 (csv row 2) が親
    expect(rows[1].plannedStartDate).toBe('2026-05-01');
    expect(rows[1].plannedEndDate).toBe('2026-05-10');
    expect(rows[1].plannedEffort).toBe(5);
  });

  it('BOM 付きでも先頭文字を読み飛ばしてパースできる', () => {
    const bom = '﻿';
    const csv = bom + [HEADER_7, ',WP,A,1,,,0'].join('\n');
    const { rows } = parseSyncImportCsv(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('A');
  });

  it('予定工数が空欄なら null', () => {
    const csv = [HEADER_7, ',WP,A,1,,,'].join('\n');
    const { rows } = parseSyncImportCsv(csv);
    expect(rows[0].plannedEffort).toBe(null);
  });

  it('レベルが数値変換できない行はスキップされる', () => {
    const csv = [HEADER_7, ',WP,有効,1,,,0', ',WP,無効,abc,,,0'].join('\n');
    const { rows } = parseSyncImportCsv(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('有効');
  });

  it('名称が空欄の行はスキップされる', () => {
    const csv = [HEADER_7, ',WP,,1,,,0', ',WP,有効,1,,,0'].join('\n');
    const { rows } = parseSyncImportCsv(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('有効');
  });

  // [A1] parentRowIndex 推論
  it('[A1] 別 WP 配下の同名 ACT は別の parentRowIndex を持つ', () => {
    const csv = [
      HEADER_7,
      ',WP,WPA,1,,,0',
      ',ACT,AACT,2,,,0',
      ',ACT,BACT,2,,,0',
      ',WP,WPB,1,,,0',
      ',ACT,AACT,2,,,0',
      ',ACT,BACT,2,,,0',
    ].join('\n');
    const { rows } = parseSyncImportCsv(csv);
    expect(rows).toHaveLength(6);
    // WPA 配下の AACT の parent は WPA (csv row 2)
    expect(rows[1].name).toBe('AACT');
    expect(rows[1].parentRowIndex).toBe(2);
    // WPB 配下の AACT の parent は WPB (csv row 5)
    expect(rows[4].name).toBe('AACT');
    expect(rows[4].parentRowIndex).toBe(5);
  });

  // [A3] ヘッダー検証
  it('[A3] ヘッダーが期待と異なれば headerErrors を返す', () => {
    const csv = ['Id,種別,名称,レベル,予定開始日,予定終了日,予定工数', ',WP,A,1,,,0'].join('\n');
    const r = parseSyncImportCsv(csv);
    expect(r.headerErrors.length).toBeGreaterThan(0);
    expect(r.headerErrors[0]).toContain('1 列目');
  });

  it('[A3] ヘッダー列順違いを検出する', () => {
    const csv = ['種別,ID,名称,レベル,予定開始日,予定終了日,予定工数', ',WP,A,1,,,0'].join('\n');
    const r = parseSyncImportCsv(csv);
    expect(r.headerErrors.some((e) => e.includes('1 列目'))).toBe(true);
  });

  it('[A3] ヘッダー列数不足を検出する (4 列未満)', () => {
    const csv = ['ID,種別,名称', ',WP,A'].join('\n');
    const r = parseSyncImportCsv(csv);
    expect(r.headerErrors.some((e) => e.includes('列数が不足'))).toBe(true);
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
    parentRowIndex: null,
    ...overrides,
  } as Parameters<typeof computeSyncDiff>[1][number];
}

describe('computeSyncDiff (T-19)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // 2026-05-10 Phase 2-8: テナント検証 mock — 全テストで「自テナント所有」の前提
    vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: projectId } as never);
  });

  it('空の CSV はグローバルエラー + canExecute=false', async () => {
    vi.mocked(prisma.task.findMany).mockResolvedValue([] as never);

    const r = await computeSyncDiff(projectId,[], 'tenant-A');
    expect(r.canExecute).toBe(false);
    expect(r.globalErrors.length).toBeGreaterThan(0);
  });

  it('500 件超は globalError', async () => {
    vi.mocked(prisma.task.findMany).mockResolvedValue([] as never);
    const rows = Array.from({ length: 501 }, (_, i) => csvRow({ tempRowIndex: i + 2, name: `t${i}` }));
    const r = await computeSyncDiff(projectId,rows, 'tenant-A');
    expect(r.canExecute).toBe(false);
    expect(r.globalErrors[0]).toContain('500 件');
  });

  it('ID 空欄 + DB に同名タスクなし → CREATE 扱い (エラーなし)', async () => {
    vi.mocked(prisma.task.findMany).mockResolvedValue([] as never);

    const r = await computeSyncDiff(projectId,[csvRow({ name: '新規タスク' })], 'tenant-A');
    expect(r.canExecute).toBe(true);
    expect(r.summary.added).toBe(1);
    expect(r.rows[0].action).toBe('CREATE');
    expect(r.rows[0].errors).toBeUndefined();
  });

  it('[A2] ID 空欄 + DB に「同一親配下の同名」タスクあり → blocker (誤コピー検知)', async () => {
    // baseDbTask: parentTaskId=null (root), name='設計'
    vi.mocked(prisma.task.findMany).mockResolvedValue([baseDbTask] as never);

    // CSV: root level の '設計' を新規作成しようとする → 同一親 (どちらも root) で衝突
    const r = await computeSyncDiff(projectId, [csvRow({ name: '設計' })], 'tenant-A');
    expect(r.canExecute).toBe(false);
    expect(r.rows[0].errors?.[0]).toContain('同一親配下に同名のタスクが既存');
  });

  it('[A2] 別の親配下なら同名でも CREATE 許可 (旧実装の過剰制限を解消)', async () => {
    // DB: 既存 root に '設計' タスク (parentTaskId=null) が存在
    vi.mocked(prisma.task.findMany).mockResolvedValue([baseDbTask] as never);

    // CSV: 'WPA' (root, id=db-1 = baseDbTask) 配下に '設計' (CREATE) を作る
    //   baseDbTask の id を流用し UPDATE 行として親を作る + その配下に CREATE を置く
    const r = await computeSyncDiff(
      projectId,
      [
        csvRow({ id: 'db-1', tempRowIndex: 2, level: 1, name: '設計' }),
        csvRow({
          tempRowIndex: 3,
          level: 2,
          type: 'activity',
          name: '設計', // 同名だが親が違う (root の '設計' は別物)
          parentRowIndex: 2,
        }),
      ],
      'tenant-A',
    );
    expect(r.canExecute).toBe(true); // ブロッカーなし
  });

  it('[A2] 親も CSV 内の CREATE (DB id 未確定) のとき誤コピー検知をスキップする', async () => {
    // DB は空。CSV で WP も ACT も新規作成。
    // resolveNewParentDbId は parentIsCsvCreate=true を返し、existingByParentAndName 照合をスキップ。
    vi.mocked(prisma.task.findMany).mockResolvedValue([] as never);

    const r = await computeSyncDiff(
      projectId,
      [
        csvRow({ tempRowIndex: 2, level: 1, name: '新規 WP' }), // CREATE 親
        csvRow({
          tempRowIndex: 3,
          level: 2,
          type: 'activity',
          name: '新規 ACT',
          parentRowIndex: 2,
        }), // CREATE 子 (親も CREATE)
      ],
      'tenant-A',
    );
    expect(r.canExecute).toBe(true);
    expect(r.summary.added).toBe(2);
    expect(r.rows[0].action).toBe('CREATE');
    expect(r.rows[1].action).toBe('CREATE');
    expect(r.rows.every((row) => !row.errors)).toBe(true);
  });

  it('[A1] level=3 (WP→sub-WP→ACT) で別 sub-WP 配下の同名 ACT は許可', async () => {
    // 階層構造: WP-A / sub-WP-A / ACT-X, WP-B / sub-WP-B / ACT-X
    // 旧バグでは level=3 + name で重複判定されていたが、parentRowIndex 含みなら別 sub-WP 配下の同名は許可される。
    vi.mocked(prisma.task.findMany).mockResolvedValue([] as never);

    const r = await computeSyncDiff(
      projectId,
      [
        csvRow({ tempRowIndex: 2, level: 1, name: 'WP-A' }),
        csvRow({ tempRowIndex: 3, level: 2, name: 'sub-WP-A', parentRowIndex: 2 }),
        csvRow({
          tempRowIndex: 4,
          level: 3,
          type: 'activity',
          name: 'ACT-X',
          parentRowIndex: 3,
        }),
        csvRow({ tempRowIndex: 5, level: 1, name: 'WP-B' }),
        csvRow({ tempRowIndex: 6, level: 2, name: 'sub-WP-B', parentRowIndex: 5 }),
        csvRow({
          tempRowIndex: 7,
          level: 3,
          type: 'activity',
          name: 'ACT-X',
          parentRowIndex: 6,
        }),
      ],
      'tenant-A',
    );
    expect(r.canExecute).toBe(true);
    expect(r.summary.added).toBe(6);
    expect(r.summary.blockedErrors).toBe(0);
  });

  it('[A1] level=3 で同一 sub-WP 配下の同名 ACT はブロック', async () => {
    // 同 sub-WP-A 配下に ACT-X が 2 つ → ブロック
    vi.mocked(prisma.task.findMany).mockResolvedValue([] as never);

    const r = await computeSyncDiff(
      projectId,
      [
        csvRow({ tempRowIndex: 2, level: 1, name: 'WP-A' }),
        csvRow({ tempRowIndex: 3, level: 2, name: 'sub-WP-A', parentRowIndex: 2 }),
        csvRow({
          tempRowIndex: 4,
          level: 3,
          type: 'activity',
          name: 'ACT-X',
          parentRowIndex: 3,
        }),
        csvRow({
          tempRowIndex: 5,
          level: 3,
          type: 'activity',
          name: 'ACT-X',
          parentRowIndex: 3,
        }),
      ],
      'tenant-A',
    );
    expect(r.canExecute).toBe(false);
    expect(
      r.rows.some((row) => row.errors?.some((e) => e.includes('同一親配下に同じ名称'))),
    ).toBe(true);
  });

  it('[A1] CSV 内: 別 WP 配下の同名 ACT は許可、同一 WP 配下の同名 ACT のみブロック', async () => {
    vi.mocked(prisma.task.findMany).mockResolvedValue([] as never);

    // WPA / AACT, BACT + WPB / AACT, BACT (別 WP 配下の同名は OK)
    const r1 = await computeSyncDiff(
      projectId,
      [
        csvRow({ tempRowIndex: 2, level: 1, name: 'WPA' }),
        csvRow({ tempRowIndex: 3, level: 2, type: 'activity', name: 'AACT', parentRowIndex: 2 }),
        csvRow({ tempRowIndex: 4, level: 2, type: 'activity', name: 'BACT', parentRowIndex: 2 }),
        csvRow({ tempRowIndex: 5, level: 1, name: 'WPB' }),
        csvRow({ tempRowIndex: 6, level: 2, type: 'activity', name: 'AACT', parentRowIndex: 5 }),
        csvRow({ tempRowIndex: 7, level: 2, type: 'activity', name: 'BACT', parentRowIndex: 5 }),
      ],
      'tenant-A',
    );
    expect(r1.canExecute).toBe(true);
    expect(r1.summary.blockedErrors).toBe(0);

    // 同一 WPA 配下に AACT が 2 つ → ブロック
    const r2 = await computeSyncDiff(
      projectId,
      [
        csvRow({ tempRowIndex: 2, level: 1, name: 'WPA' }),
        csvRow({ tempRowIndex: 3, level: 2, type: 'activity', name: 'AACT', parentRowIndex: 2 }),
        csvRow({ tempRowIndex: 4, level: 2, type: 'activity', name: 'AACT', parentRowIndex: 2 }),
      ],
      'tenant-A',
    );
    expect(r2.canExecute).toBe(false);
    expect(
      r2.rows.some((row) => row.errors?.some((e) => e.includes('同一親配下に同じ名称'))),
    ).toBe(true);
  });

  it('ID 一致 → UPDATE、変更がなければ NO_CHANGE', async () => {
    vi.mocked(prisma.task.findMany).mockResolvedValue([baseDbTask] as never);

    const r = await computeSyncDiff(projectId,[
      csvRow({ id: 'db-1', name: '設計' }),
    ], 'tenant-A');
    expect(r.canExecute).toBe(true);
    expect(r.rows[0].action).toBe('NO_CHANGE');
  });

  it('ID 一致 + 名称変更 → UPDATE + fieldChanges', async () => {
    vi.mocked(prisma.task.findMany).mockResolvedValue([baseDbTask] as never);

    const r = await computeSyncDiff(projectId,[
      csvRow({ id: 'db-1', name: '設計フェーズ' }),
    ], 'tenant-A');
    expect(r.summary.updated).toBe(1);
    expect(r.rows[0].action).toBe('UPDATE');
    expect(r.rows[0].fieldChanges?.[0]).toMatchObject({ field: 'name', before: '設計', after: '設計フェーズ' });
  });

  it('ID が DB に存在しない → blocker', async () => {
    vi.mocked(prisma.task.findMany).mockResolvedValue([] as never);

    const r = await computeSyncDiff(projectId,[csvRow({ id: 'unknown-id', name: 'X' })], 'tenant-A');
    expect(r.canExecute).toBe(false);
    // [B2] エラーメッセージはガイダンス化済 — 「ID 〜 のタスクが〜存在しません」
    expect(r.rows[0].errors?.[0]).toContain('ID「unknown-id」');
    expect(r.rows[0].errors?.[0]).toContain('存在しません');
  });

  it('WP↔ACT 切替は blocker', async () => {
    vi.mocked(prisma.task.findMany).mockResolvedValue([baseDbTask] as never); // 既存は WP

    const r = await computeSyncDiff(projectId,[
      csvRow({ id: 'db-1', name: '設計', type: 'activity' }),
    ], 'tenant-A');
    expect(r.canExecute).toBe(false);
    expect(r.rows[0].errors?.some((e) => e.includes('種別'))).toBe(true);
  });

  it('CSV 内 ID 重複は blocker', async () => {
    vi.mocked(prisma.task.findMany).mockResolvedValue([baseDbTask, { ...baseDbTask, id: 'db-2', name: '別' }] as never);

    const r = await computeSyncDiff(projectId,[
      csvRow({ id: 'db-1', name: '設計', tempRowIndex: 2 }),
      csvRow({ id: 'db-1', name: '設計2', tempRowIndex: 3 }),
    ], 'tenant-A');
    expect(r.canExecute).toBe(false);
    // [B2] エラーメッセージはガイダンス化済 — 「CSV 内に同じ ID〜を持つ行が複数あります」
    expect(r.rows[0].errors?.some((e) => e.includes('同じ ID') && e.includes('db-1'))).toBe(true);
  });

  it('CSV から消えたタスク → REMOVE_CANDIDATE 行を追加', async () => {
    vi.mocked(prisma.task.findMany).mockResolvedValue([
      baseDbTask,
      { ...baseDbTask, id: 'db-2', name: 'もう必要ないタスク', progressRate: 0, actualStartDate: null },
    ] as never);

    const r = await computeSyncDiff(projectId,[
      csvRow({ id: 'db-1', name: '設計' }),
    ], 'tenant-A');
    const removeRow = r.rows.find((row) => row.action === 'REMOVE_CANDIDATE');
    expect(removeRow).toBeDefined();
    expect(removeRow?.name).toBe('もう必要ないタスク');
    expect(removeRow?.hasProgress).toBe(false);
  });

  it('[C2] snapshotAt が dry-run 時点の最大 updatedAt を返す', async () => {
    const t1 = new Date('2026-05-01T00:00:00Z');
    const t2 = new Date('2026-05-21T10:30:00Z');
    vi.mocked(prisma.task.findMany).mockResolvedValue([
      { ...baseDbTask, id: 'db-1', updatedAt: t1 },
      { ...baseDbTask, id: 'db-2', name: '別', updatedAt: t2 },
    ] as never);

    const r = await computeSyncDiff(projectId, [csvRow({ id: 'db-1', name: '設計' })], 'tenant-A');
    expect(r.snapshotAt).toBe(t2.toISOString());
  });

  it('進捗ありタスクの REMOVE_CANDIDATE は ERROR レベル', async () => {
    vi.mocked(prisma.task.findMany).mockResolvedValue([
      baseDbTask,
      { ...baseDbTask, id: 'db-2', name: '進捗あり', progressRate: 50, actualStartDate: new Date() },
    ] as never);

    const r = await computeSyncDiff(projectId,[
      csvRow({ id: 'db-1', name: '設計' }),
    ], 'tenant-A');
    const removeRow = r.rows.find((row) => row.action === 'REMOVE_CANDIDATE');
    expect(removeRow?.hasProgress).toBe(true);
    expect(removeRow?.warningLevel).toBe('ERROR');
  });
});

// ============================================================
// applySyncImport — [C2] OCC concurrent edit detection
// ============================================================

describe('applySyncImport [C2] OCC', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: projectId } as never);
  });

  it('expectedSnapshotAt と現在の snapshotAt が一致しなければ IMPORT_CONCURRENT_EDIT を throw', async () => {
    const tNow = new Date('2026-05-21T12:00:00Z');
    vi.mocked(prisma.task.findMany).mockResolvedValue([
      { ...baseDbTask, id: 'db-1', updatedAt: tNow },
    ] as never);

    // client が送る expectedSnapshotAt は古いタイムスタンプ
    const stale = '2026-05-21T11:00:00.000Z';

    await expect(
      applySyncImport(
        projectId,
        [csvRow({ id: 'db-1', name: '設計' })],
        'keep',
        'user-1',
        'tenant-A',
        { expectedSnapshotAt: stale },
      ),
    ).rejects.toThrow(/IMPORT_CONCURRENT_EDIT/);
  });

  it('expectedSnapshotAt が一致すれば OCC をパスする (dry-run/再計算 → snapshotAt 同一)', async () => {
    const tNow = new Date('2026-05-21T12:00:00Z');
    vi.mocked(prisma.task.findMany).mockResolvedValue([
      { ...baseDbTask, id: 'db-1', updatedAt: tNow },
    ] as never);
    vi.mocked(prisma.task.update).mockResolvedValue({ id: 'db-1' } as never);
    vi.mocked(prisma.task.findUnique).mockResolvedValue({ type: 'work_package', parentTaskId: null } as never);

    // expectedSnapshotAt は現在の最大 updatedAt と一致
    const expected = tNow.toISOString();

    // 同名 UPDATE (変更なし) なので OCC のみ検証できる
    const result = await applySyncImport(
      projectId,
      [csvRow({ id: 'db-1', name: '設計' })],
      'keep',
      'user-1',
      'tenant-A',
      { expectedSnapshotAt: expected },
    );
    // NO_CHANGE 扱いになるが、OCC throw されないことが本テストの主目的
    expect(result).toBeDefined();
  });
});
