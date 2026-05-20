import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  prisma: {
    retrospective: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
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

import {
  parseRetrospectiveSyncImportCsv,
  computeRetrospectiveSyncDiff,
  applyRetrospectiveSyncImport,
} from './retrospective-sync-import.service';
import { prisma } from '@/lib/db';

const HEADER_13 = 'ID,実施日,計画総括,実績総括,良かった点,課題,見積差異要因,スケジュール差異要因,品質課題,リスク対応評価,改善事項,共有ナレッジ,公開範囲';

describe('parseRetrospectiveSyncImportCsv (T-22 Phase 22b)', () => {
  it('ヘッダーのみは空配列を返す', () => {
    expect(parseRetrospectiveSyncImportCsv(HEADER_13)).toEqual([]);
  });

  it('ID あり行 + ID 空欄行をパースできる', () => {
    const csv = [
      HEADER_13,
      // 12 commas = 13 fields
      'r-1,2026-04-15,計画A,実績A,良点A,課題A,見積要因A,スケ要因A,品質A,リスクA,改善A,共有A,public',
      ',2026-04-22,,,,,,,,,改善のみ,,public',
    ].join('\n');

    const rows = parseRetrospectiveSyncImportCsv(csv);
    expect(rows).toHaveLength(2);
    expect(rows[0].id).toBe('r-1');
    expect(rows[0].conductedDate).toBe('2026-04-15');
    expect(rows[0].planSummary).toBe('計画A');
    expect(rows[0].visibility).toBe('public');
    expect(rows[1].id).toBe(null);
    expect(rows[1].improvements).toBe('改善のみ');
  });

  it('実施日が無効な行はスキップされる', () => {
    const csv = [HEADER_13, ',invalid-date,,,,,,,,,,,public', ',2026-04-15,,,,,,,,,有効,,public'].join('\n');
    const rows = parseRetrospectiveSyncImportCsv(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0].improvements).toBe('有効');
  });

  it('BOM 付きでもパースできる', () => {
    const csv = '﻿' + [HEADER_13, ',2026-04-15,,,,,,,,,,,public'].join('\n');
    const rows = parseRetrospectiveSyncImportCsv(csv);
    expect(rows).toHaveLength(1);
  });

  it('不正な visibility はデフォルト public', () => {
    const csv = [HEADER_13, ',2026-04-15,,,,,,,,,,,bad'].join('\n');
    const rows = parseRetrospectiveSyncImportCsv(csv);
    expect(rows[0].visibility).toBe('public');
  });
});

const projectId = 'proj-1';

const baseDbRetro = {
  id: 'r-1',
  projectId,
  conductedDate: new Date('2026-04-15'),
  planSummary: '計画',
  actualSummary: '実績',
  goodPoints: '良',
  problems: '課題',
  estimateGapFactors: null,
  scheduleGapFactors: null,
  qualityIssues: null,
  riskResponseEvaluation: null,
  improvements: '改善',
  knowledgeToShare: null,
  state: 'draft',
  visibility: 'public',
};

function csvRow(overrides: Record<string, unknown> = {}) {
  return {
    tempRowIndex: 2,
    id: null,
    conductedDate: '2026-04-15',
    planSummary: '計画',
    actualSummary: '実績',
    goodPoints: '良',
    problems: '課題',
    estimateGapFactors: null,
    scheduleGapFactors: null,
    qualityIssues: null,
    riskResponseEvaluation: null,
    improvements: '改善',
    knowledgeToShare: null,
    visibility: 'public',
    ...overrides,
  } as Parameters<typeof computeRetrospectiveSyncDiff>[1][number];
}

describe('computeRetrospectiveSyncDiff (T-22 Phase 22b)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // 2026-05-10 Phase 2-8: テナント検証 mock — 全テストで「自テナント所有」の前提
    vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: projectId } as never);
    // 2026-05-10 Phase 2-8: applyRetrospectiveSyncImport 内 owned check のデフォルト
    vi.mocked(prisma.retrospective.findFirst).mockResolvedValue({ id: 'r-1' } as never);
  });

  it('空の CSV はグローバルエラー', async () => {
    vi.mocked(prisma.retrospective.findMany).mockResolvedValue([] as never);
    const r = await computeRetrospectiveSyncDiff(projectId, [], 'tenant-A');
    expect(r.canExecute).toBe(false);
  });

  it('500 件超は globalError', async () => {
    vi.mocked(prisma.retrospective.findMany).mockResolvedValue([] as never);
    const rows = Array.from({ length: 501 }, (_, i) => csvRow({ tempRowIndex: i + 2, conductedDate: `2026-${String(Math.floor(i / 28) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}` }));
    const r = await computeRetrospectiveSyncDiff(projectId, rows, 'tenant-A');
    expect(r.canExecute).toBe(false);
    expect(r.globalErrors[0]).toContain('500 件');
  });

  it('ID 空欄 + DB 同実施日なし → CREATE', async () => {
    vi.mocked(prisma.retrospective.findMany).mockResolvedValue([] as never);
    const r = await computeRetrospectiveSyncDiff(projectId, [csvRow({ conductedDate: '2026-05-01' })], 'tenant-A');
    expect(r.canExecute).toBe(true);
    expect(r.summary.added).toBe(1);
  });

  it('ID 空欄 + DB 同実施日あり → blocker', async () => {
    vi.mocked(prisma.retrospective.findMany).mockResolvedValue([baseDbRetro] as never);
    const r = await computeRetrospectiveSyncDiff(projectId, [csvRow({ conductedDate: '2026-04-15' })], 'tenant-A');
    expect(r.canExecute).toBe(false);
    expect(r.rows[0].errors?.[0]).toContain('同じ実施日');
  });

  it('ID 一致 + 変更なし → NO_CHANGE', async () => {
    vi.mocked(prisma.retrospective.findMany).mockResolvedValue([baseDbRetro] as never);
    const r = await computeRetrospectiveSyncDiff(projectId, [csvRow({ id: 'r-1' })], 'tenant-A');
    expect(r.rows[0].action).toBe('NO_CHANGE');
  });

  it('ID 一致 + improvements 変更 → UPDATE + fieldChanges', async () => {
    vi.mocked(prisma.retrospective.findMany).mockResolvedValue([baseDbRetro] as never);
    const r = await computeRetrospectiveSyncDiff(projectId, [csvRow({ id: 'r-1', improvements: '改善 v2' })], 'tenant-A');
    expect(r.rows[0].action).toBe('UPDATE');
    expect(r.rows[0].fieldChanges?.find((fc) => fc.field === 'improvements')).toBeDefined();
  });

  it('ID DB に不在 → blocker', async () => {
    vi.mocked(prisma.retrospective.findMany).mockResolvedValue([] as never);
    const r = await computeRetrospectiveSyncDiff(projectId, [csvRow({ id: 'unknown' })], 'tenant-A');
    expect(r.canExecute).toBe(false);
  });

  it('CSV から消えた state=draft の retro → REMOVE_CANDIDATE (WARN)', async () => {
    vi.mocked(prisma.retrospective.findMany).mockResolvedValue([
      baseDbRetro,
      { ...baseDbRetro, id: 'r-2', conductedDate: new Date('2026-03-20'), state: 'draft' },
    ] as never);
    const r = await computeRetrospectiveSyncDiff(projectId, [csvRow({ id: 'r-1' })], 'tenant-A');
    const removeRow = r.rows.find((row) => row.action === 'REMOVE_CANDIDATE');
    expect(removeRow?.hasProgress).toBe(false);
    expect(removeRow?.warningLevel).toBe('WARN');
  });

  it('CSV から消えた state != draft → REMOVE_CANDIDATE (ERROR)', async () => {
    vi.mocked(prisma.retrospective.findMany).mockResolvedValue([
      baseDbRetro,
      { ...baseDbRetro, id: 'r-2', conductedDate: new Date('2026-03-20'), state: 'finalized' },
    ] as never);
    const r = await computeRetrospectiveSyncDiff(projectId, [csvRow({ id: 'r-1' })], 'tenant-A');
    const removeRow = r.rows.find((row) => row.action === 'REMOVE_CANDIDATE');
    expect(removeRow?.hasProgress).toBe(true);
    expect(removeRow?.warningLevel).toBe('ERROR');
  });

  it('CSV 内 ID 重複は blocker', async () => {
    vi.mocked(prisma.retrospective.findMany).mockResolvedValue([baseDbRetro, { ...baseDbRetro, id: 'r-2', conductedDate: new Date('2026-03-20') }] as never);
    const r = await computeRetrospectiveSyncDiff(projectId, [
      csvRow({ id: 'r-1', conductedDate: '2026-04-15', tempRowIndex: 2 }),
      csvRow({ id: 'r-1', conductedDate: '2026-03-20', tempRowIndex: 3 }),
    ], 'tenant-A');
    expect(r.canExecute).toBe(false);
  });
});

describe('applyRetrospectiveSyncImport (T-22 Phase 22b)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: projectId } as never);
    // feat/crud-permission-redesign (2026-05-20): creator gating のため createdBy を含める
    vi.mocked(prisma.retrospective.findFirst).mockResolvedValue({ id: 'r-1', createdBy: 'u-1' } as never);
  });

  it('canExecute=false なら IMPORT_VALIDATION_ERROR を投げる', async () => {
    vi.mocked(prisma.retrospective.findMany).mockResolvedValue([] as never);
    await expect(applyRetrospectiveSyncImport(projectId, [], 'keep', 'u-1', 'tenant-A'))
      .rejects.toThrow(/IMPORT_VALIDATION_ERROR/);
  });

  it('CREATE 行 + UPDATE 行を実行できる', async () => {
    vi.mocked(prisma.retrospective.findMany).mockResolvedValue([baseDbRetro] as never);
    vi.mocked(prisma.retrospective.update).mockResolvedValue({} as never);
    vi.mocked(prisma.retrospective.create).mockResolvedValue({ id: 'r-new' } as never);

    const result = await applyRetrospectiveSyncImport(projectId, [
      csvRow({ id: 'r-1', improvements: '改善 v2' }),
      csvRow({ conductedDate: '2026-05-01', improvements: '新規' }),
    ], 'keep', 'u-1', 'tenant-A');

    expect(result.added).toBe(1);
    expect(result.updated).toBe(1);
  });
});
