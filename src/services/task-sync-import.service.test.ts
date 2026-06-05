import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  prisma: {
    task: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      createMany: vi.fn(),
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

// ADR-0032 (2026-06-04): applySyncImport の WP 集計再計算は最後に recalculateAllProjectWps を 1 回呼ぶ。
// 単体テストでは実 DB を伴わない no-op に差し替える。
vi.mock('./task.service', async () => {
  const actual = await vi.importActual<typeof import('./task.service')>('./task.service');
  return {
    ...actual,
    recalculateAllProjectWps: vi.fn().mockResolvedValue({ total: 0, updated: 0 }),
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

  // fix/csv-import-multiline-text-data-loss: 「名称」は短文想定だが、ユーザが
  //   改行を含む CSV を作成した場合に silent に欠落・行ずれ崩壊しないことを保証する。
  it('★★ 名称に改行が含まれていても欠落・行ずれせず正しく扱う', () => {
    const csv = [
      HEADER_7,
      ',WP,"設計\n(詳細)",1,,,0',
      ',ACT,"要件\nヒアリング",2,2026-05-01,2026-05-10,5',
    ].join('\n');
    const { rows, headerErrors } = parseSyncImportCsv(csv);
    expect(headerErrors).toEqual([]);
    expect(rows).toHaveLength(2);
    expect(rows[0].name).toBe('設計\n(詳細)');
    expect(rows[1].name).toBe('要件\nヒアリング');
    // multi-line を跨いでも level スタック (parentRowIndex) が崩れない
    expect(rows[1].parentRowIndex).toBe(2);
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

  it('[ADR-0032] 目安件数を超えても block せず globalWarning を返す (ハード上限撤廃)', async () => {
    // ADR-0032 (2026-06-04): 旧「500 件ハード上限 (canExecute=false)」を撤廃。
    //   createMany バッチ化で大量取込も完走できるため、目安超過は「時間がかかる場合がある」警告に留める。
    vi.mocked(prisma.task.findMany).mockResolvedValue([] as never);
    const rows = Array.from({ length: 501 }, (_, i) => csvRow({ tempRowIndex: i + 2, name: `t${i}` }));
    const r = await computeSyncDiff(projectId, rows, 'tenant-A');
    expect(r.canExecute).toBe(true);
    expect(r.globalErrors).toEqual([]);
    expect(r.globalWarnings.some((w) => w.includes('時間がかかる'))).toBe(true);
  });

  it('[ADR-0032] 目安件数以下では globalWarning は出ない', async () => {
    vi.mocked(prisma.task.findMany).mockResolvedValue([] as never);
    const r = await computeSyncDiff(projectId, [csvRow({ name: '少数' })], 'tenant-A');
    expect(r.globalWarnings).toEqual([]);
  });

  it('ID 空欄 + DB に同名タスクなし → CREATE 扱い (エラーなし)', async () => {
    vi.mocked(prisma.task.findMany).mockResolvedValue([] as never);

    const r = await computeSyncDiff(projectId,[csvRow({ name: '新規タスク' })], 'tenant-A');
    expect(r.canExecute).toBe(true);
    expect(r.summary.added).toBe(1);
    expect(r.rows[0].action).toBe('CREATE');
    expect(r.rows[0].errors).toBeUndefined();
  });

  it('[A2] ID 空欄 + DB に「同一親配下の同名」タスクあり → warning (新規 ID で別タスク作成、canExecute は維持)', async () => {
    // fix/list-export-import-bugs (2026-05-26): parent+name 重複は ID が一意なら別タスクとして許容するよう
    //   warning にダウングレード。canExecute はブロックしない。
    // baseDbTask: parentTaskId=null (root), name='設計'
    vi.mocked(prisma.task.findMany).mockResolvedValue([baseDbTask] as never);

    // CSV: root level の '設計' を新規作成しようとする → 同一親 (どちらも root) で衝突 (warning)
    const r = await computeSyncDiff(projectId, [csvRow({ name: '設計' })], 'tenant-A');
    expect(r.canExecute).toBe(true);
    expect(r.rows[0].warnings?.some((w) => w.includes('同一親配下に同名'))).toBe(true);
    expect(r.rows[0].warningLevel).toBe('WARN');
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

  it('[A1] level=3 で同一 sub-WP 配下の同名 ACT は warning (canExecute は維持)', async () => {
    // fix/list-export-import-bugs (2026-05-26): parent+name 重複は warning にダウングレード
    // 同 sub-WP-A 配下に ACT-X が 2 つ → warning (新規 ID で別タスク作成)
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
    expect(r.canExecute).toBe(true);
    expect(
      r.rows.some((row) => row.warnings?.some((w) => w.includes('同一親配下に同じ名称'))),
    ).toBe(true);
  });

  it('[A1] CSV 内: 別 WP 配下の同名 ACT は許可、同一 WP 配下の同名 ACT は warning (canExecute は維持)', async () => {
    // fix/list-export-import-bugs (2026-05-26): parent+name 重複は warning にダウングレード
    vi.mocked(prisma.task.findMany).mockResolvedValue([] as never);

    // WPA / AACT, BACT + WPB / AACT, BACT (別 WP 配下の同名は OK / warning 無し)
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

    // 同一 WPA 配下に AACT が 2 つ → warning (新規 ID で別タスク作成)
    const r2 = await computeSyncDiff(
      projectId,
      [
        csvRow({ tempRowIndex: 2, level: 1, name: 'WPA' }),
        csvRow({ tempRowIndex: 3, level: 2, type: 'activity', name: 'AACT', parentRowIndex: 2 }),
        csvRow({ tempRowIndex: 4, level: 2, type: 'activity', name: 'AACT', parentRowIndex: 2 }),
      ],
      'tenant-A',
    );
    expect(r2.canExecute).toBe(true);
    expect(
      r2.rows.some((row) => row.warnings?.some((w) => w.includes('同一親配下に同じ名称'))),
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

// ============================================================
// applySyncImport — ADR-0032 createMany バッチ化 (504 タイムアウト対策)
// ============================================================

describe('applySyncImport [ADR-0032] createMany バッチ', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: projectId } as never);
    vi.mocked(prisma.task.createMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(prisma.task.update).mockResolvedValue({ id: 'x' } as never);
    vi.mocked(prisma.task.updateMany).mockResolvedValue({ count: 0 } as never);
  });

  it('全 CREATE: createMany を level ごとに呼び、同一親配下の同名 ACT も両方作成される', async () => {
    // DB は空 (computeSyncDiff の既存タスク取得 + rollback 用 snapshot の両方)
    vi.mocked(prisma.task.findMany).mockResolvedValue([] as never);

    const result = await applySyncImport(
      projectId,
      [
        csvRow({ tempRowIndex: 2, level: 1, type: 'work_package', name: 'WP' }),
        csvRow({
          tempRowIndex: 3, level: 2, type: 'activity', name: 'SC午後1問', parentRowIndex: 2,
          plannedStartDate: '2026-06-07', plannedEndDate: '2026-06-07', plannedEffort: 2,
        }),
        // 同一 WP 配下に同名 ACT (旧実装は P2002 で 500 になっていたケース)
        csvRow({
          tempRowIndex: 4, level: 2, type: 'activity', name: 'SC午後1問', parentRowIndex: 2,
          plannedStartDate: '2026-06-13', plannedEndDate: '2026-06-13', plannedEffort: 2,
        }),
      ],
      'keep',
      'user-1',
      'tenant-A',
    );

    expect(result.added).toBe(3);
    // 逐次 create は使わない (バッチ化されている)
    expect(prisma.task.create).not.toHaveBeenCalled();
    // level 1 と level 2 で 1 回ずつ = 2 回
    expect(prisma.task.createMany).toHaveBeenCalledTimes(2);

    // level 2 のバッチに同名 ACT が 2 件、ID は別 (= 別タスクとして取り込まれる)
    const calls = vi.mocked(prisma.task.createMany).mock.calls;
    const level2Call = calls.find((c) => (c[0] as { data: unknown[] }).data.length === 2);
    expect(level2Call).toBeDefined();
    const data = (level2Call![0] as { data: Array<{ id: string; name: string; parentTaskId: string | null }> }).data;
    expect(data.every((d) => d.name === 'SC午後1問')).toBe(true);
    expect(data[0].id).not.toBe(data[1].id);
    // 親 (level 1 の WP) の id が両方の parentTaskId に一致する
    expect(data[0].parentTaskId).toBe(data[1].parentTaskId);
    expect(data[0].parentTaskId).not.toBeNull();
  });

  it('removeMode=delete: 進捗なし REMOVE_CANDIDATE を updateMany で一括論理削除する', async () => {
    // CSV には db-1 のみ。db-2 (進捗なし) は CSV に無い → REMOVE_CANDIDATE。
    vi.mocked(prisma.task.findMany).mockResolvedValue([
      { ...baseDbTask, id: 'db-1', name: '残す', updatedAt: new Date('2026-05-01T00:00:00Z') },
      { ...baseDbTask, id: 'db-2', name: '消す', progressRate: 0, actualStartDate: null, updatedAt: new Date('2026-05-01T00:00:00Z') },
    ] as never);

    const result = await applySyncImport(
      projectId,
      [csvRow({ id: 'db-1', name: '残す' })],
      'delete',
      'user-1',
      'tenant-A',
    );

    expect(result.removed).toBe(1);
    expect(prisma.task.updateMany).toHaveBeenCalledTimes(1);
    const call = vi.mocked(prisma.task.updateMany).mock.calls[0][0] as {
      where: { id: { in: string[] } };
      data: { deletedAt: Date };
    };
    expect(call.where.id.in).toEqual(['db-2']);
    expect(call.data.deletedAt).toBeInstanceOf(Date);
  });
});
