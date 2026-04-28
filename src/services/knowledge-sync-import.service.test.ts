import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  prisma: {
    knowledge: {
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
    const csv = [HEADER_14, ',T,unknown,,,,,,xyz,bad,,,,bad'].join('\n');
    const rows = parseKnowledgeSyncImportCsv(csv);
    expect(rows[0].knowledgeType).toBe('other');
    expect(rows[0].reusability).toBe(null);
    expect(rows[0].devMethod).toBe(null);
    expect(rows[0].visibility).toBe('public');
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
  beforeEach(() => vi.clearAllMocks());

  it('空の CSV はグローバルエラー', async () => {
    vi.mocked(prisma.knowledge.findMany).mockResolvedValue([] as never);
    const r = await computeKnowledgeSyncDiff(projectId, []);
    expect(r.canExecute).toBe(false);
  });

  it('ID 空欄 + DB 同タイトルなし → CREATE', async () => {
    vi.mocked(prisma.knowledge.findMany).mockResolvedValue([] as never);
    const r = await computeKnowledgeSyncDiff(projectId, [csvRow({ title: '新規ナレッジ' })]);
    expect(r.canExecute).toBe(true);
    expect(r.summary.added).toBe(1);
  });

  it('ID 空欄 + DB 同タイトルあり → blocker', async () => {
    vi.mocked(prisma.knowledge.findMany).mockResolvedValue([baseDbKnowledge] as never);
    const r = await computeKnowledgeSyncDiff(projectId, [csvRow({ title: 'React導入' })]);
    expect(r.canExecute).toBe(false);
  });

  it('ID 一致 + 変更なし → NO_CHANGE', async () => {
    vi.mocked(prisma.knowledge.findMany).mockResolvedValue([baseDbKnowledge] as never);
    const r = await computeKnowledgeSyncDiff(projectId, [csvRow({ id: 'k-1' })]);
    expect(r.rows[0].action).toBe('NO_CHANGE');
  });

  it('tags 変更を fieldChanges で検出', async () => {
    vi.mocked(prisma.knowledge.findMany).mockResolvedValue([baseDbKnowledge] as never);
    const r = await computeKnowledgeSyncDiff(projectId, [csvRow({ id: 'k-1', techTags: ['react', 'next.js'] })]);
    expect(r.rows[0].action).toBe('UPDATE');
    expect(r.rows[0].fieldChanges?.find((fc) => fc.field === 'techTags')).toBeDefined();
  });

  it('CSV から消えた visibility=draft → REMOVE_CANDIDATE (WARN)', async () => {
    vi.mocked(prisma.knowledge.findMany).mockResolvedValue([
      baseDbKnowledge,
      { ...baseDbKnowledge, id: 'k-2', title: 'draft K', visibility: 'draft' },
    ] as never);
    const r = await computeKnowledgeSyncDiff(projectId, [csvRow({ id: 'k-1' })]);
    const removeRow = r.rows.find((row) => row.action === 'REMOVE_CANDIDATE');
    expect(removeRow?.hasProgress).toBe(false);
  });

  it('CSV から消えた visibility=public → REMOVE_CANDIDATE (ERROR)', async () => {
    vi.mocked(prisma.knowledge.findMany).mockResolvedValue([
      baseDbKnowledge,
      { ...baseDbKnowledge, id: 'k-2', title: 'public K', visibility: 'public' },
    ] as never);
    const r = await computeKnowledgeSyncDiff(projectId, [csvRow({ id: 'k-1' })]);
    const removeRow = r.rows.find((row) => row.action === 'REMOVE_CANDIDATE');
    expect(removeRow?.hasProgress).toBe(true);
    expect(removeRow?.warningLevel).toBe('ERROR');
  });

  it('ID DB に不在 → blocker', async () => {
    vi.mocked(prisma.knowledge.findMany).mockResolvedValue([] as never);
    const r = await computeKnowledgeSyncDiff(projectId, [csvRow({ id: 'unknown' })]);
    expect(r.canExecute).toBe(false);
  });
});

describe('applyKnowledgeSyncImport (T-22 Phase 22c)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('canExecute=false なら IMPORT_VALIDATION_ERROR を投げる', async () => {
    vi.mocked(prisma.knowledge.findMany).mockResolvedValue([] as never);
    await expect(applyKnowledgeSyncImport(projectId, [], 'keep', 'u-1'))
      .rejects.toThrow(/IMPORT_VALIDATION_ERROR/);
  });

  it('CREATE 行は knowledgeProjects junction を作成', async () => {
    vi.mocked(prisma.knowledge.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.knowledge.create).mockResolvedValue({ id: 'k-new' } as never);

    const result = await applyKnowledgeSyncImport(projectId, [csvRow({ title: '新規' })], 'keep', 'u-1');
    expect(result.added).toBe(1);
    expect(prisma.knowledge.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          knowledgeProjects: { create: { projectId } },
        }),
      }),
    );
  });
});
