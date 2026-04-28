import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  prisma: {
    memo: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
}));

import {
  parseMemoSyncImportCsv,
  computeMemoSyncDiff,
  applyMemoSyncImport,
} from './memo-sync-import.service';
import { prisma } from '@/lib/db';

const HEADER_4 = 'ID,タイトル,本文,公開範囲';

describe('parseMemoSyncImportCsv (T-22 Phase 22d)', () => {
  it('ヘッダーのみは空配列を返す', () => {
    expect(parseMemoSyncImportCsv(HEADER_4)).toEqual([]);
  });

  it('ID あり行 + ID 空欄行をパースできる', () => {
    const csv = [
      HEADER_4,
      'm-1,既存メモ,本文 A,public',
      ',新規メモ,本文 B,private',
    ].join('\n');

    const rows = parseMemoSyncImportCsv(csv);
    expect(rows).toHaveLength(2);
    expect(rows[0].id).toBe('m-1');
    expect(rows[0].title).toBe('既存メモ');
    expect(rows[0].content).toBe('本文 A');
    expect(rows[0].visibility).toBe('public');
    expect(rows[1].id).toBe(null);
    expect(rows[1].visibility).toBe('private');
  });

  it('タイトルが空の行はスキップされる', () => {
    const csv = [HEADER_4, ',,,public', ',有効,本文,private'].join('\n');
    const rows = parseMemoSyncImportCsv(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('有効');
  });

  it('不正な visibility はデフォルト private', () => {
    const csv = [HEADER_4, ',T,,bad'].join('\n');
    const rows = parseMemoSyncImportCsv(csv);
    expect(rows[0].visibility).toBe('private');
  });

  it('BOM 付きでもパースできる', () => {
    const csv = '﻿' + [HEADER_4, ',M,,public'].join('\n');
    const rows = parseMemoSyncImportCsv(csv);
    expect(rows).toHaveLength(1);
  });
});

const userId = 'u-1';

const baseDbMemo = {
  id: 'm-1',
  userId,
  title: '既存メモ',
  content: '本文',
  visibility: 'private',
};

function csvRow(overrides: Record<string, unknown> = {}) {
  return {
    tempRowIndex: 2,
    id: null,
    title: '既存メモ',
    content: '本文',
    visibility: 'private',
    ...overrides,
  } as Parameters<typeof computeMemoSyncDiff>[1][number];
}

describe('computeMemoSyncDiff (T-22 Phase 22d, user-scoped)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('空の CSV はグローバルエラー', async () => {
    vi.mocked(prisma.memo.findMany).mockResolvedValue([] as never);
    const r = await computeMemoSyncDiff(userId, []);
    expect(r.canExecute).toBe(false);
  });

  it('500 件超は globalError', async () => {
    vi.mocked(prisma.memo.findMany).mockResolvedValue([] as never);
    const rows = Array.from({ length: 501 }, (_, i) => csvRow({ tempRowIndex: i + 2, title: `M${i}` }));
    const r = await computeMemoSyncDiff(userId, rows);
    expect(r.canExecute).toBe(false);
  });

  it('ID 空欄 + DB 同タイトルなし → CREATE', async () => {
    vi.mocked(prisma.memo.findMany).mockResolvedValue([] as never);
    const r = await computeMemoSyncDiff(userId, [csvRow({ title: '新規' })]);
    expect(r.canExecute).toBe(true);
    expect(r.summary.added).toBe(1);
  });

  it('ID 空欄 + DB 同タイトルあり → blocker', async () => {
    vi.mocked(prisma.memo.findMany).mockResolvedValue([baseDbMemo] as never);
    const r = await computeMemoSyncDiff(userId, [csvRow({ title: '既存メモ' })]);
    expect(r.canExecute).toBe(false);
  });

  it('ID 一致 + 変更なし → NO_CHANGE', async () => {
    vi.mocked(prisma.memo.findMany).mockResolvedValue([baseDbMemo] as never);
    const r = await computeMemoSyncDiff(userId, [csvRow({ id: 'm-1' })]);
    expect(r.rows[0].action).toBe('NO_CHANGE');
  });

  it('ID 一致 + content 変更 → UPDATE', async () => {
    vi.mocked(prisma.memo.findMany).mockResolvedValue([baseDbMemo] as never);
    const r = await computeMemoSyncDiff(userId, [csvRow({ id: 'm-1', content: '本文 v2' })]);
    expect(r.rows[0].action).toBe('UPDATE');
  });

  it('ID DB に不在 → blocker (他ユーザのメモは見えない)', async () => {
    vi.mocked(prisma.memo.findMany).mockResolvedValue([] as never);
    const r = await computeMemoSyncDiff(userId, [csvRow({ id: 'm-other' })]);
    expect(r.canExecute).toBe(false);
    expect(r.rows[0].errors?.[0]).toContain('自分のメモ以外は同期できません');
  });

  it('CSV から消えた visibility=public → REMOVE_CANDIDATE (ERROR)', async () => {
    vi.mocked(prisma.memo.findMany).mockResolvedValue([
      baseDbMemo,
      { ...baseDbMemo, id: 'm-2', title: 'public M', visibility: 'public' },
    ] as never);
    const r = await computeMemoSyncDiff(userId, [csvRow({ id: 'm-1' })]);
    const removeRow = r.rows.find((row) => row.action === 'REMOVE_CANDIDATE');
    expect(removeRow?.hasProgress).toBe(true);
    expect(removeRow?.warningLevel).toBe('ERROR');
  });

  it('CSV から消えた visibility=private → REMOVE_CANDIDATE (WARN)', async () => {
    vi.mocked(prisma.memo.findMany).mockResolvedValue([
      baseDbMemo,
      { ...baseDbMemo, id: 'm-2', title: 'private M', visibility: 'private' },
    ] as never);
    const r = await computeMemoSyncDiff(userId, [csvRow({ id: 'm-1' })]);
    const removeRow = r.rows.find((row) => row.action === 'REMOVE_CANDIDATE');
    expect(removeRow?.hasProgress).toBe(false);
    expect(removeRow?.warningLevel).toBe('WARN');
  });

  it('CSV 内 ID 重複は blocker', async () => {
    vi.mocked(prisma.memo.findMany).mockResolvedValue([baseDbMemo, { ...baseDbMemo, id: 'm-2', title: '別メモ' }] as never);
    const r = await computeMemoSyncDiff(userId, [
      csvRow({ id: 'm-1', tempRowIndex: 2 }),
      csvRow({ id: 'm-1', title: '別タイトル', tempRowIndex: 3 }),
    ]);
    expect(r.canExecute).toBe(false);
  });
});

describe('applyMemoSyncImport (T-22 Phase 22d)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('canExecute=false なら IMPORT_VALIDATION_ERROR を投げる', async () => {
    vi.mocked(prisma.memo.findMany).mockResolvedValue([] as never);
    await expect(applyMemoSyncImport(userId, [], 'keep'))
      .rejects.toThrow(/IMPORT_VALIDATION_ERROR/);
  });

  it('CREATE 行 + UPDATE 行を実行', async () => {
    vi.mocked(prisma.memo.findMany).mockResolvedValue([baseDbMemo] as never);
    vi.mocked(prisma.memo.update).mockResolvedValue({} as never);
    vi.mocked(prisma.memo.create).mockResolvedValue({ id: 'm-new' } as never);

    const result = await applyMemoSyncImport(userId, [
      csvRow({ id: 'm-1', content: '本文 v2' }),
      csvRow({ title: '新規メモ' }),
    ], 'keep');

    expect(result.added).toBe(1);
    expect(result.updated).toBe(1);
  });

  it('removeMode=delete + visibility=public は IMPORT_REMOVE_BLOCKED', async () => {
    vi.mocked(prisma.memo.findMany).mockResolvedValue([
      baseDbMemo,
      { ...baseDbMemo, id: 'm-2', title: 'public', visibility: 'public' },
    ] as never);

    await expect(applyMemoSyncImport(userId, [csvRow({ id: 'm-1' })], 'delete'))
      .rejects.toThrow(/IMPORT_REMOVE_BLOCKED/);
  });
});
