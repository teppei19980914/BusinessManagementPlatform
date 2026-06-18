import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  prisma: {
    knowledge: {
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
  parseKnowledgeSyncImportCsv,
  computeKnowledgeSyncDiff,
  applyKnowledgeSyncImport,
} from './knowledge-sync-import.service';
import { prisma } from '@/lib/db';

const HEADER_14 = 'ID,タイトル,ナレッジ種別,背景,内容,結果,結論,推奨,再利用性,開発方式,技術タグ (;区切り),プロセスタグ (;区切り),業界ドメインタグ (;区切り),公開範囲';

describe('parseKnowledgeSyncImportCsv (T-22 Phase 22c)', () => {
  it('ヘッダーのみは空配列を返す', () => {
    expect(parseKnowledgeSyncImportCsv(HEADER_14)).toEqual([]);
  });

  it('ID あり行 + ID 空欄行をパースできる (tags はセミコロン区切り)', () => {
    // Build CSV programmatically to avoid manual comma counting bugs
    const row1 = ['k-1', 'React導入事例', 'best_practice', '背景', '内容', '結果', '結論', '推奨', 'high', 'scratch', 'react;next.js', '設計', 'WEB', 'public'];
    const row2 = ['', 'Vue検証', 'verification', '', '', '', '', '', '', '', 'vue;vite', '', 'SaaS', 'draft'];
    const csv = [HEADER_14, row1.join(','), row2.join(',')].join('\n');

    const rows = parseKnowledgeSyncImportCsv(csv);
    expect(rows).toHaveLength(2);
    expect(rows[0].id).toBe('k-1');
    expect(rows[0].title).toBe('React導入事例');
    expect(rows[0].knowledgeType).toBe('best_practice');
    expect(rows[0].techTags).toEqual(['react', 'next.js']);
    expect(rows[0].businessDomainTags).toEqual(['WEB']);
    expect(rows[0].visibility).toBe('public');

    expect(rows[1].id).toBe(null);
    expect(rows[1].techTags).toEqual(['vue', 'vite']);
    expect(rows[1].visibility).toBe('draft');
  });

  it('タイトルが空の行はスキップされる', () => {
    const csv = [HEADER_14, ',,best_practice,,,,,,,,,,,public', ',有効,best_practice,,,,,,,,,,,public'].join('\n');
    const rows = parseKnowledgeSyncImportCsv(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('有効');
  });

  it('不正な enum 値はデフォルトに丸められる', () => {
    // v1.3.0: visibility 既定(public)の検証なので、背景/内容/結果を埋めて draft 降格を回避する。
    const csv = [HEADER_14, ',T,unknown,bg,ct,rs,,,xyz,bad,,,,bad'].join('\n');
    const rows = parseKnowledgeSyncImportCsv(csv);
    expect(rows[0].knowledgeType).toBe('other');
    expect(rows[0].reusability).toBe(null);
    expect(rows[0].devMethod).toBe(null);
    expect(rows[0].visibility).toBe('public');
  });

  // v1.3.0 軽量入力 (2026-06-19): public だが本文 (背景/内容/結果) が空なら draft へ降格。
  it('public 指定でも本文が空なら draft へ降格 (v1.3.0)', () => {
    const csv = [HEADER_14, ',T,best_practice,,,,,,,,,,,public'].join('\n');
    const rows = parseKnowledgeSyncImportCsv(csv);
    expect(rows[0].visibility).toBe('draft');
  });

  // fix/csv-import-multiline-text-data-loss: 旧実装は背景/内容/結果 (textarea 入力可) の
  //   quoted multi-line cell の 2 行目以降を silent に欠落させていた。
  //   主に「エクスポート→Excel 編集→再インポート」経路で再現する。
  it('★★ background/content/result の quoted multi-line cell が欠落しない (7 列新形式)', () => {
    const HEADER_7 = 'ID,タイトル,ナレッジ種別,背景,内容,結果,公開範囲';
    const csv = [
      HEADER_7,
      'k-1,T1,best_practice,"背景1行目\n背景2行目","内容A\n内容B\n内容C","結果\n複数行",public',
    ].join('\n');
    const rows = parseKnowledgeSyncImportCsv(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0].background).toBe('背景1行目\n背景2行目');
    expect(rows[0].content).toBe('内容A\n内容B\n内容C');
    expect(rows[0].result).toBe('結果\n複数行');
    expect(rows[0].visibility).toBe('public');
  });

  it('14 列旧形式でも multi-line cell が欠落しない', () => {
    const csv = [
      HEADER_14,
      'k-1,T1,best_practice,"bg\n2","ct\n2","res\n2","結論\n2","推奨\n2",high,scratch,react,plan,WEB,public',
    ].join('\n');
    const rows = parseKnowledgeSyncImportCsv(csv);
    expect(rows[0].background).toBe('bg\n2');
    expect(rows[0].content).toBe('ct\n2');
    expect(rows[0].result).toBe('res\n2');
    expect(rows[0].conclusion).toBe('結論\n2');
    expect(rows[0].recommendation).toBe('推奨\n2');
  });
});

const projectId = 'proj-1';

const baseDbKnowledge = {
  id: 'k-1',
  title: 'React導入',
  knowledgeType: 'best_practice',
  background: '背景',
  content: '内容',
  result: '結果',
  conclusion: null,
  recommendation: null,
  reusability: 'high',
  devMethod: 'scratch',
  techTags: ['react'],
  processTags: [],
  businessDomainTags: [],
  visibility: 'public',
  createdBy: 'u-A',
};

function csvRow(overrides: Record<string, unknown> = {}) {
  return {
    tempRowIndex: 2,
    id: null,
    title: 'React導入',
    knowledgeType: 'best_practice',
    background: '背景',
    content: '内容',
    result: '結果',
    conclusion: null,
    recommendation: null,
    reusability: 'high',
    devMethod: 'scratch',
    techTags: ['react'],
    processTags: [],
    businessDomainTags: [],
    visibility: 'public',
    ...overrides,
  } as Parameters<typeof computeKnowledgeSyncDiff>[1][number];
}

describe('computeKnowledgeSyncDiff (T-22 Phase 22c)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // 2026-05-10 Phase 2-8: テナント検証 mock — 全テストで「自テナント所有」の前提
    vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: projectId } as never);
  });

  it('空の CSV はグローバルエラー', async () => {
    vi.mocked(prisma.knowledge.findMany).mockResolvedValue([] as never);
    const r = await computeKnowledgeSyncDiff(projectId, [], 'tenant-A');
    expect(r.canExecute).toBe(false);
  });

  it('ID 空欄 + DB 同タイトルなし → CREATE', async () => {
    vi.mocked(prisma.knowledge.findMany).mockResolvedValue([] as never);
    const r = await computeKnowledgeSyncDiff(projectId, [csvRow({ title: '新規ナレッジ' })], 'tenant-A');
    expect(r.canExecute).toBe(true);
    expect(r.summary.added).toBe(1);
  });

  it('ID 空欄 + DB 同タイトルあり → warning (新規 ID で別エンティティ作成、canExecute は維持)', async () => {
    // fix/list-export-import-bugs (2026-05-26): title 重複は ID が一意なら別エンティティとして許容するよう
    // warning にダウングレードした。canExecute はブロックしない。
    vi.mocked(prisma.knowledge.findMany).mockResolvedValue([baseDbKnowledge] as never);
    const r = await computeKnowledgeSyncDiff(projectId, [csvRow({ title: 'React導入' })], 'tenant-A');
    expect(r.canExecute).toBe(true);
    expect(r.rows[0].warnings?.some((w) => w.includes('React導入'))).toBe(true);
    expect(r.rows[0].warningLevel).toBe('WARN');
  });

  it('ID 一致 + 変更なし → NO_CHANGE', async () => {
    vi.mocked(prisma.knowledge.findMany).mockResolvedValue([baseDbKnowledge] as never);
    const r = await computeKnowledgeSyncDiff(projectId, [csvRow({ id: 'k-1' })], 'tenant-A');
    expect(r.rows[0].action).toBe('NO_CHANGE');
  });

  it('tags 変更を fieldChanges で検出', async () => {
    vi.mocked(prisma.knowledge.findMany).mockResolvedValue([baseDbKnowledge] as never);
    const r = await computeKnowledgeSyncDiff(projectId, [csvRow({ id: 'k-1', techTags: ['react', 'next.js'] })], 'tenant-A');
    expect(r.rows[0].action).toBe('UPDATE');
    expect(r.rows[0].fieldChanges?.find((fc) => fc.field === 'techTags')).toBeDefined();
  });

  it('CSV から消えた visibility=draft → REMOVE_CANDIDATE (WARN)', async () => {
    vi.mocked(prisma.knowledge.findMany).mockResolvedValue([
      baseDbKnowledge,
      { ...baseDbKnowledge, id: 'k-2', title: 'draft K', visibility: 'draft' },
    ] as never);
    const r = await computeKnowledgeSyncDiff(projectId, [csvRow({ id: 'k-1' })], 'tenant-A');
    const removeRow = r.rows.find((row) => row.action === 'REMOVE_CANDIDATE');
    expect(removeRow?.hasProgress).toBe(false);
  });

  it('CSV から消えた visibility=public → REMOVE_CANDIDATE (ERROR)', async () => {
    vi.mocked(prisma.knowledge.findMany).mockResolvedValue([
      baseDbKnowledge,
      { ...baseDbKnowledge, id: 'k-2', title: 'public K', visibility: 'public' },
    ] as never);
    const r = await computeKnowledgeSyncDiff(projectId, [csvRow({ id: 'k-1' })], 'tenant-A');
    const removeRow = r.rows.find((row) => row.action === 'REMOVE_CANDIDATE');
    expect(removeRow?.hasProgress).toBe(true);
    expect(removeRow?.warningLevel).toBe('ERROR');
  });

  it('ID DB に不在 → blocker', async () => {
    vi.mocked(prisma.knowledge.findMany).mockResolvedValue([] as never);
    const r = await computeKnowledgeSyncDiff(projectId, [csvRow({ id: 'unknown' })], 'tenant-A');
    expect(r.canExecute).toBe(false);
  });
});

describe('applyKnowledgeSyncImport (T-22 Phase 22c)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // 2026-05-10 Phase 2-8: テナント検証 mock
    vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: projectId } as never);
  });

  it('canExecute=false なら IMPORT_VALIDATION_ERROR を投げる', async () => {
    vi.mocked(prisma.knowledge.findMany).mockResolvedValue([] as never);
    await expect(applyKnowledgeSyncImport(projectId, [], 'keep', 'u-1', 'tenant-A'))
      .rejects.toThrow(/IMPORT_VALIDATION_ERROR/);
  });

  it('CREATE 行は knowledgeProjects junction を作成', async () => {
    vi.mocked(prisma.knowledge.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.knowledge.create).mockResolvedValue({ id: 'k-new' } as never);

    const result = await applyKnowledgeSyncImport(projectId, [csvRow({ title: '新規' })], 'keep', 'u-1', 'tenant-A');
    expect(result.added).toBe(1);
    expect(prisma.knowledge.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          knowledgeProjects: { create: { projectId } },
        }),
      }),
    );
  });

  // feat/crud-permission-redesign (2026-05-20, 2 巡目検証 Test-G3): 他人作成 silent skip 回帰防止
  it('UPDATE 行で他人作成 (createdBy !== userId) は silent skip + skippedNotOwned カウント', async () => {
    // 既存 knowledge は other-user が作成、import 実行ユーザは u-1
    // baseDbKnowledge をベースに id と createdBy を上書きして使う (tag 配列等の必須 fields 確保)
    const otherUserDbKnowledge = { ...baseDbKnowledge, id: 'k-existing', createdBy: 'other-user' };
    vi.mocked(prisma.knowledge.findMany).mockResolvedValue([otherUserDbKnowledge] as never);
    vi.mocked(prisma.knowledge.findFirst).mockResolvedValue({
      id: 'k-existing',
      createdBy: 'other-user',
    } as never);

    const result = await applyKnowledgeSyncImport(
      projectId,
      [csvRow({ id: 'k-existing', title: '上書き試行' })],
      'keep',
      'u-1',
      'tenant-A',
    );

    // update は呼ばれず、updated カウントは 0、skippedNotOwned が 1
    expect(prisma.knowledge.update).not.toHaveBeenCalled();
    expect(result.updated).toBe(0);
    expect(result.skippedNotOwned).toBe(1);
  });
});
