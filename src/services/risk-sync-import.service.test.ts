import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  prisma: {
    riskIssue: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    projectMember: {
      findMany: vi.fn(),
    },
    // 2026-05-10 Phase 2-8: 越境 sync-import 遮断のため project の tenant 検証を実施
    project: {
      findFirst: vi.fn(),
    },
  },
}));

import {
  parseRiskSyncImportCsv,
  computeRiskSyncDiff,
} from './risk-sync-import.service';
import { prisma } from '@/lib/db';

// T-22 Phase 22a: 16 列ヘッダー
const HEADER_16 = 'ID,種別,件名,内容,原因,影響度,発生確率,対応方針,対応詳細,担当者氏名,期限,状態,結果,教訓,公開範囲,リスク性質';

describe('parseRiskSyncImportCsv (T-22 Phase 22a)', () => {
  it('ヘッダーのみは空配列を返す', () => {
    expect(parseRiskSyncImportCsv(HEADER_16)).toEqual([]);
  });

  it('ID あり行 + ID 空欄行をパースできる', () => {
    const csv = [
      HEADER_16,
      // 15 commas = 16 fields (ID/type/title/content/cause/impact/likelihood/responsePolicy/responseDetail/assigneeName/deadline/state/result/lessonLearned/visibility/riskNature)
      'r-1,risk,DBダウン懸念,内容詳細,原因詳細,high,medium,対応方針,対応詳細,Alice,2026-06-01,open,,,public,threat',
      ',issue,テスト遅延,内容,,medium,,,,,,open,,,public,',
    ].join('\n');

    const rows = parseRiskSyncImportCsv(csv);
    expect(rows).toHaveLength(2);
    expect(rows[0].id).toBe('r-1');
    expect(rows[0].type).toBe('risk');
    expect(rows[0].title).toBe('DBダウン懸念');
    expect(rows[0].impact).toBe('high');
    expect(rows[0].likelihood).toBe('medium');
    expect(rows[0].assigneeName).toBe('Alice');
    expect(rows[0].deadline).toBe('2026-06-01');
    expect(rows[0].state).toBe('open');
    expect(rows[0].visibility).toBe('public');
    expect(rows[0].riskNature).toBe('threat');

    expect(rows[1].id).toBe(null);
    expect(rows[1].type).toBe('issue');
    expect(rows[1].title).toBe('テスト遅延');
    expect(rows[1].likelihood).toBe(null);
    expect(rows[1].riskNature).toBe(null);
  });

  it('BOM 付きでも先頭文字を読み飛ばしてパースできる', () => {
    const bom = '﻿';
    const csv = bom + [HEADER_16, ',risk,A,,,medium,,,,,,open,,,public,'].join('\n');
    const rows = parseRiskSyncImportCsv(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('A');
  });

  it('件名が空の行はスキップされる', () => {
    const csv = [HEADER_16, ',risk,,,,medium,,,,,,open,,,public,', ',risk,有効,,,medium,,,,,,open,,,public,'].join('\n');
    const rows = parseRiskSyncImportCsv(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('有効');
  });

  it('不正な enum 値はデフォルトに丸められる (impact=medium / state=open / visibility=public)', () => {
    const csv = [HEADER_16, ',unknown,T,,,xyz,,,,,,bad,,,bad,nope'].join('\n');
    const rows = parseRiskSyncImportCsv(csv);
    expect(rows[0].type).toBe('risk'); // unknown → 'risk' (default)
    expect(rows[0].impact).toBe('medium');
    expect(rows[0].state).toBe('open');
    expect(rows[0].visibility).toBe('public');
    expect(rows[0].riskNature).toBe(null);
  });

  // fix/csv-import-multiline-text-data-loss: 内容/原因/対応方針/対応詳細/結果/教訓 は textarea
  //   入力で改行を含むことが多く、旧 split 方式は 2 行目以降を silent に欠落させていた。
  it('★★ content/cause/responsePolicy/responseDetail の quoted multi-line cell が欠落しない', () => {
    const csv = [
      HEADER_16,
      'r-1,risk,T1,"内容1\n内容2","原因A\n原因B",high,medium,"方針X\n方針Y","詳細1\n詳細2\n詳細3",Alice,2026-06-01,open,"結果\n複数行","教訓\n2行",public,threat',
    ].join('\n');
    const rows = parseRiskSyncImportCsv(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe('内容1\n内容2');
    expect(rows[0].cause).toBe('原因A\n原因B');
    expect(rows[0].responsePolicy).toBe('方針X\n方針Y');
    expect(rows[0].responseDetail).toBe('詳細1\n詳細2\n詳細3');
    expect(rows[0].result).toBe('結果\n複数行');
    expect(rows[0].lessonLearned).toBe('教訓\n2行');
  });
});

const projectId = 'proj-1';

const baseDbRisk = {
  id: 'r-1',
  projectId,
  type: 'risk',
  title: 'DB ダウン',
  content: '内容',
  cause: null,
  impact: 'high',
  likelihood: 'medium',
  priority: 'high',
  responsePolicy: null,
  responseDetail: null,
  reporterId: 'u-A',
  assigneeId: null,
  deadline: null,
  state: 'open',
  result: null,
  lessonLearned: null,
  visibility: 'public',
  riskNature: null,
  createdBy: 'u-A',
  updatedBy: 'u-A',
};

function csvRow(overrides: Record<string, unknown> = {}) {
  return {
    tempRowIndex: 2,
    id: null,
    type: 'risk',
    title: 'DB ダウン',
    content: '内容',
    cause: null,
    impact: 'high',
    likelihood: 'medium',
    responsePolicy: null,
    responseDetail: null,
    assigneeName: null,
    deadline: null,
    state: 'open',
    result: null,
    lessonLearned: null,
    visibility: 'public',
    riskNature: null,
    ...overrides,
  } as Parameters<typeof computeRiskSyncDiff>[1][number];
}

describe('computeRiskSyncDiff (T-22 Phase 22a)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // 2026-05-10 Phase 2-8: テナント検証 mock — 全テストで「自テナント所有」の前提
    vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: projectId } as never);
  });

  it('空の CSV はグローバルエラー + canExecute=false', async () => {
    vi.mocked(prisma.riskIssue.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.projectMember.findMany).mockResolvedValue([] as never);

    const r = await computeRiskSyncDiff(projectId, [], 'tenant-A');
    expect(r.canExecute).toBe(false);
    expect(r.globalErrors.length).toBeGreaterThan(0);
  });

  it('ID 空欄 + DB に同名なし → CREATE 扱い (エラーなし)', async () => {
    vi.mocked(prisma.riskIssue.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.projectMember.findMany).mockResolvedValue([] as never);

    const r = await computeRiskSyncDiff(projectId, [csvRow({ title: '新規リスク' })], 'tenant-A');
    expect(r.canExecute).toBe(true);
    expect(r.summary.added).toBe(1);
    expect(r.rows[0].action).toBe('CREATE');
    expect(r.rows[0].errors).toBeUndefined();
  });

  it('ID 空欄 + DB に同件名あり → warning (新規 ID で別エンティティ作成、canExecute は維持)', async () => {
    // fix/list-export-import-bugs (2026-05-26): title 重複は warning にダウングレード
    vi.mocked(prisma.riskIssue.findMany).mockResolvedValue([baseDbRisk] as never);
    vi.mocked(prisma.projectMember.findMany).mockResolvedValue([] as never);

    const r = await computeRiskSyncDiff(projectId, [csvRow({ title: 'DB ダウン' })], 'tenant-A');
    expect(r.canExecute).toBe(true);
    expect(r.rows[0].warnings?.some((w) => w.includes('DB ダウン'))).toBe(true);
    expect(r.rows[0].warningLevel).toBe('WARN');
  });

  it('ID 一致 → UPDATE、変更がなければ NO_CHANGE', async () => {
    vi.mocked(prisma.riskIssue.findMany).mockResolvedValue([baseDbRisk] as never);
    vi.mocked(prisma.projectMember.findMany).mockResolvedValue([] as never);

    const r = await computeRiskSyncDiff(projectId, [
      csvRow({ id: 'r-1', title: 'DB ダウン' }),
    ], 'tenant-A');
    expect(r.canExecute).toBe(true);
    expect(r.rows[0].action).toBe('NO_CHANGE');
  });

  it('ID 一致 + 件名変更 → UPDATE + fieldChanges', async () => {
    vi.mocked(prisma.riskIssue.findMany).mockResolvedValue([baseDbRisk] as never);
    vi.mocked(prisma.projectMember.findMany).mockResolvedValue([] as never);

    const r = await computeRiskSyncDiff(projectId, [
      csvRow({ id: 'r-1', title: 'DB 完全停止' }),
    ], 'tenant-A');
    expect(r.summary.updated).toBe(1);
    expect(r.rows[0].action).toBe('UPDATE');
    expect(r.rows[0].fieldChanges?.find((fc) => fc.field === 'title')).toMatchObject({
      before: 'DB ダウン',
      after: 'DB 完全停止',
    });
  });

  it('type 切替 (risk → issue) は blocker', async () => {
    vi.mocked(prisma.riskIssue.findMany).mockResolvedValue([baseDbRisk] as never); // 既存は risk
    vi.mocked(prisma.projectMember.findMany).mockResolvedValue([] as never);

    const r = await computeRiskSyncDiff(projectId, [
      csvRow({ id: 'r-1', title: 'DB ダウン', type: 'issue' }),
    ], 'tenant-A');
    expect(r.canExecute).toBe(false);
    expect(r.rows[0].errors?.some((e) => e.includes('種別'))).toBe(true);
  });

  it('担当者氏名がメンバー外 → blocker', async () => {
    vi.mocked(prisma.riskIssue.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.projectMember.findMany).mockResolvedValue([
      { user: { id: 'u-1', name: 'Alice' }, projectId, userId: 'u-1', projectRole: 'member', assignedBy: 'x', id: 'pm-1', createdAt: new Date(), updatedAt: new Date() },
    ] as never);

    const r = await computeRiskSyncDiff(projectId, [
      csvRow({ title: '新規', assigneeName: 'Charlie' }),
    ], 'tenant-A');
    expect(r.canExecute).toBe(false);
    expect(r.rows[0].errors?.some((e) => e.includes('担当者 "Charlie"'))).toBe(true);
  });

  it('CSV 内 ID 重複は blocker', async () => {
    vi.mocked(prisma.riskIssue.findMany).mockResolvedValue([baseDbRisk, { ...baseDbRisk, id: 'r-2', title: '別件' }] as never);
    vi.mocked(prisma.projectMember.findMany).mockResolvedValue([] as never);

    const r = await computeRiskSyncDiff(projectId, [
      csvRow({ id: 'r-1', title: 'DB ダウン', tempRowIndex: 2 }),
      csvRow({ id: 'r-1', title: 'DB ダウン 2', tempRowIndex: 3 }),
    ], 'tenant-A');
    expect(r.canExecute).toBe(false);
    expect(r.rows[0].errors?.some((e) => e.includes('CSV 内で ID'))).toBe(true);
  });

  it('CSV から消えた state=open のタスク → REMOVE_CANDIDATE (WARN)', async () => {
    vi.mocked(prisma.riskIssue.findMany).mockResolvedValue([
      baseDbRisk,
      { ...baseDbRisk, id: 'r-2', title: '解決した課題', state: 'open' },
    ] as never);
    vi.mocked(prisma.projectMember.findMany).mockResolvedValue([] as never);

    const r = await computeRiskSyncDiff(projectId, [
      csvRow({ id: 'r-1', title: 'DB ダウン' }),
    ], 'tenant-A');
    const removeRow = r.rows.find((row) => row.action === 'REMOVE_CANDIDATE');
    expect(removeRow).toBeDefined();
    expect(removeRow?.name).toBe('解決した課題');
    expect(removeRow?.hasProgress).toBe(false);
    expect(removeRow?.warningLevel).toBe('WARN');
  });

  it('CSV から消えた state != open のタスク → REMOVE_CANDIDATE (ERROR)', async () => {
    vi.mocked(prisma.riskIssue.findMany).mockResolvedValue([
      baseDbRisk,
      { ...baseDbRisk, id: 'r-2', title: '対応中', state: 'in_progress' },
    ] as never);
    vi.mocked(prisma.projectMember.findMany).mockResolvedValue([] as never);

    const r = await computeRiskSyncDiff(projectId, [
      csvRow({ id: 'r-1', title: 'DB ダウン' }),
    ], 'tenant-A');
    const removeRow = r.rows.find((row) => row.action === 'REMOVE_CANDIDATE');
    expect(removeRow?.hasProgress).toBe(true);
    expect(removeRow?.warningLevel).toBe('ERROR');
  });
});
