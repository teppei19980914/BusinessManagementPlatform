import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  prisma: {
    $queryRaw: vi.fn(),
  },
}));

vi.mock('./embedding.service', async () => {
  const actual = await vi.importActual<typeof import('./embedding.service')>(
    './embedding.service',
  );
  return {
    ...actual,
    generateBatchEmbeddings: vi.fn(),
  };
});

import {
  searchHelpContent,
  buildRagPromptSection,
  composeFaqContentText,
  composeGuideContentText,
  computeContentHash,
  mapVisibleToFlags,
  HELP_SEARCH_DEFAULT_LIMIT,
} from './help-search.service';
import { prisma } from '@/lib/db';
import { generateBatchEmbeddings } from './embedding.service';
import { FAQ_ENTRIES } from '@/config/faq-content';
import { GUIDE_STEPS } from '@/config/guide-content';

const mockedQueryRaw = vi.mocked(prisma.$queryRaw);
const mockedGenerate = vi.mocked(generateBatchEmbeddings);

const TENANT_ID = '00000000-0000-0000-0000-000000000001';
const USER_ID = '00000000-0000-0000-0000-000000000010';

const VIEWER_ALL = { isTenantAdmin: false, hasAnyProjectPmRole: false };
const VIEWER_ADMIN = { isTenantAdmin: true, hasAnyProjectPmRole: false };

function fakeEmbedding(): number[] {
  return Array.from({ length: 1024 }, (_, i) => (i % 2 === 0 ? 0.1 : -0.1));
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ================================================================
// 純粋関数 (script との共有 hash 計算)
// ================================================================

describe('composeFaqContentText / composeGuideContentText', () => {
  it('FAQ は "Q: ... \\n\\nA: ..." 形式', () => {
    const entry = FAQ_ENTRIES[0];
    const text = composeFaqContentText(entry);
    expect(text).toBe(`Q: ${entry.q}\n\nA: ${entry.a}`);
  });

  it('Guide は "タイトル: ... \\n\\n手順: ..." 形式', () => {
    const step = GUIDE_STEPS[0];
    const text = composeGuideContentText(step);
    expect(text).toBe(`タイトル: ${step.title}\n\n手順: ${step.body}`);
  });
});

describe('computeContentHash', () => {
  it('SHA-256 64 文字 hex を返す', () => {
    const h = computeContentHash('test');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it('同一入力は同一 hash', () => {
    expect(computeContentHash('abc')).toBe(computeContentHash('abc'));
  });

  it('異なる入力は異なる hash', () => {
    expect(computeContentHash('abc')).not.toBe(computeContentHash('abd'));
  });
});

describe('mapVisibleToFlags', () => {
  it('all → 両 false', () => {
    expect(mapVisibleToFlags('all')).toEqual({ requiresAdmin: false, requiresProjectPm: false });
  });
  it('tenant_admin → requiresAdmin=true', () => {
    expect(mapVisibleToFlags('tenant_admin')).toEqual({ requiresAdmin: true, requiresProjectPm: false });
  });
  it('project_pm → requiresProjectPm=true', () => {
    expect(mapVisibleToFlags('project_pm')).toEqual({ requiresAdmin: false, requiresProjectPm: true });
  });
});

// ================================================================
// buildRagPromptSection
// ================================================================

describe('buildRagPromptSection', () => {
  it('空配列なら fallback 文言を返す', () => {
    const out = buildRagPromptSection([]);
    expect(out).toContain('該当する FAQ・使い方ガイドが見つかりませんでした');
    expect(out).toContain('## 参考情報');
  });

  it('hits 各件を [kind:id] (score) 形式で含める', () => {
    const out = buildRagPromptSection([
      { kind: 'faq', entryId: 'foo-bar', snapshot: 'Q: 質問\n\nA: 回答', score: 0.85 },
      { kind: 'guide', entryId: 'how-to', snapshot: 'タイトル: T\n\n手順: 1', score: 0.42 },
    ]);
    expect(out).toContain('[faq:foo-bar] (score: 0.85)');
    expect(out).toContain('Q: 質問');
    expect(out).toContain('[guide:how-to] (score: 0.42)');
  });
});

// ================================================================
// searchHelpContent
// ================================================================

describe('searchHelpContent — degraded ルート', () => {
  it('query 空白のみ → embedding 呼ばずに degraded=true', async () => {
    const r = await searchHelpContent({
      query: '   ',
      tenantId: TENANT_ID,
      userId: USER_ID,
      viewer: VIEWER_ALL,
    });
    expect(mockedGenerate).not.toHaveBeenCalled();
    expect(r.degraded).toBe(true);
    expect(r.degradedReason).toBe('empty_query');
    expect(r.hits).toEqual([]);
    expect(r.costJpy).toBe(0);
  });

  it('embedding 失敗 → degraded=true、hits=[]、costJpy=0', async () => {
    mockedGenerate.mockResolvedValueOnce({
      ok: false,
      reason: 'llm_error',
      message: 'voyage timeout',
    });
    const r = await searchHelpContent({
      query: '請求はいつですか',
      tenantId: TENANT_ID,
      userId: USER_ID,
      viewer: VIEWER_ALL,
    });
    expect(r.degraded).toBe(true);
    expect(r.degradedReason).toContain('embed_failed:llm_error');
    expect(r.hits).toEqual([]);
    expect(mockedQueryRaw).not.toHaveBeenCalled();
  });

  it('embedding throw → degraded=true', async () => {
    mockedGenerate.mockRejectedValueOnce(new Error('boom'));
    const r = await searchHelpContent({
      query: 'foo',
      tenantId: TENANT_ID,
      userId: USER_ID,
      viewer: VIEWER_ALL,
    });
    expect(r.degraded).toBe(true);
    expect(r.degradedReason).toContain('embed_throw:boom');
  });

  it('pgvector throw → degraded=true (embedding cost は返す)', async () => {
    mockedGenerate.mockResolvedValueOnce({
      ok: true,
      embeddings: [fakeEmbedding()],
      costJpy: 0,
      requestId: 'req-1',
    });
    mockedQueryRaw.mockRejectedValueOnce(new Error('db down'));
    const r = await searchHelpContent({
      query: 'foo',
      tenantId: TENANT_ID,
      userId: USER_ID,
      viewer: VIEWER_ALL,
    });
    expect(r.degraded).toBe(true);
    expect(r.degradedReason).toContain('pgvector_throw:db down');
    expect(r.requestId).toBe('req-1');
  });
});

describe('searchHelpContent — 正常ルート', () => {
  it('embedding + pgvector 成功 → snapshot を config から再構成して返す', async () => {
    mockedGenerate.mockResolvedValueOnce({
      ok: true,
      embeddings: [fakeEmbedding()],
      costJpy: 0,
      requestId: 'req-2',
    });
    // FAQ 検索結果に既存 FAQ id を返させる
    const knownFaqId = FAQ_ENTRIES.find((e) => e.visibleTo === 'all')!.id;
    mockedQueryRaw
      .mockResolvedValueOnce([{ entry_id: knownFaqId, score: 0.9 }])
      .mockResolvedValueOnce([]); // guide_embeddings

    const r = await searchHelpContent({
      query: 'なんでも質問',
      tenantId: TENANT_ID,
      userId: USER_ID,
      viewer: VIEWER_ALL,
    });

    expect(r.degraded).toBe(false);
    expect(r.hits.length).toBe(1);
    expect(r.hits[0].kind).toBe('faq');
    expect(r.hits[0].entryId).toBe(knownFaqId);
    expect(r.hits[0].snapshot).toContain('Q:');
    expect(r.hits[0].snapshot).toContain('A:');
    expect(r.hits[0].score).toBeCloseTo(0.9);
    expect(r.requestId).toBe('req-2');
  });

  it('★severity-1★ defense-in-depth: SQL が許可外 FAQ を返しても TS 側で除外', async () => {
    mockedGenerate.mockResolvedValueOnce({
      ok: true,
      embeddings: [fakeEmbedding()],
      costJpy: 0,
      requestId: 'req-3',
    });
    // tenant_admin 限定 FAQ を一般ユーザ (VIEWER_ALL) 検索に対し返す異常系
    const adminOnly = FAQ_ENTRIES.find((e) => e.visibleTo === 'tenant_admin')!.id;
    mockedQueryRaw
      .mockResolvedValueOnce([{ entry_id: adminOnly, score: 0.95 }])
      .mockResolvedValueOnce([]);

    const r = await searchHelpContent({
      query: '請求はいつですか',
      tenantId: TENANT_ID,
      userId: USER_ID,
      viewer: VIEWER_ALL,
    });

    // TS 層で getFaqEntriesForRole と intersect されるため、admin-only は除外される
    expect(r.hits.find((h) => h.entryId === adminOnly)).toBeUndefined();
    expect(r.degraded).toBe(false);
  });

  it('admin 権限ユーザは tenant_admin FAQ も受け取る', async () => {
    mockedGenerate.mockResolvedValueOnce({
      ok: true,
      embeddings: [fakeEmbedding()],
      costJpy: 0,
      requestId: 'req-4',
    });
    const adminOnly = FAQ_ENTRIES.find((e) => e.visibleTo === 'tenant_admin')!.id;
    mockedQueryRaw
      .mockResolvedValueOnce([{ entry_id: adminOnly, score: 0.95 }])
      .mockResolvedValueOnce([]);

    const r = await searchHelpContent({
      query: '請求はいつですか',
      tenantId: TENANT_ID,
      userId: USER_ID,
      viewer: VIEWER_ADMIN,
    });

    expect(r.hits.find((h) => h.entryId === adminOnly)).toBeDefined();
  });

  it('DB に存在するが config から削除済 entry は除外 (drift 防御)', async () => {
    mockedGenerate.mockResolvedValueOnce({
      ok: true,
      embeddings: [fakeEmbedding()],
      costJpy: 0,
      requestId: 'req-5',
    });
    mockedQueryRaw
      .mockResolvedValueOnce([{ entry_id: 'deleted-entry-id-not-in-config', score: 0.99 }])
      .mockResolvedValueOnce([]);

    const r = await searchHelpContent({
      query: 'foo',
      tenantId: TENANT_ID,
      userId: USER_ID,
      viewer: VIEWER_ADMIN,
    });
    expect(r.hits).toEqual([]);
  });

  it('FAQ + Guide 混在で score 降順 + limit cap が効く', async () => {
    mockedGenerate.mockResolvedValueOnce({
      ok: true,
      embeddings: [fakeEmbedding()],
      costJpy: 0,
      requestId: 'req-6',
    });
    const faqId = FAQ_ENTRIES.find((e) => e.visibleTo === 'all')!.id;
    const guideId = GUIDE_STEPS.find((s) => s.visibleTo === 'all')!.id;
    mockedQueryRaw
      .mockResolvedValueOnce([{ entry_id: faqId, score: 0.5 }])
      .mockResolvedValueOnce([{ entry_id: guideId, score: 0.8 }]);

    const r = await searchHelpContent({
      query: 'test',
      tenantId: TENANT_ID,
      userId: USER_ID,
      viewer: VIEWER_ALL,
      limit: 2,
    });
    expect(r.hits.length).toBeLessThanOrEqual(2);
    expect(r.hits[0].score).toBeGreaterThanOrEqual(r.hits[r.hits.length - 1].score);
    expect(r.hits[0].entryId).toBe(guideId); // 0.8 > 0.5
  });

  it('default limit は HELP_SEARCH_DEFAULT_LIMIT', () => {
    expect(HELP_SEARCH_DEFAULT_LIMIT).toBeGreaterThan(0);
    expect(HELP_SEARCH_DEFAULT_LIMIT).toBeLessThanOrEqual(10);
  });
});
