import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

vi.mock('@/lib/api-helpers', () => ({
  getAuthenticatedUser: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    tenant: { findUnique: vi.fn() },
  },
}));

vi.mock('@/services/chat-search.service', () => ({
  chatSemanticSearch: vi.fn(),
}));

vi.mock('@/services/error-log.service', () => ({
  recordError: vi.fn().mockResolvedValue(undefined),
}));

import { POST } from './route';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { prisma } from '@/lib/db';
import { chatSemanticSearch } from '@/services/chat-search.service';
import { recordError } from '@/services/error-log.service';

const mockedGetAuth = vi.mocked(getAuthenticatedUser);
const mockedTenantFind = vi.mocked(prisma.tenant.findUnique);
const mockedChatSearch = vi.mocked(chatSemanticSearch);
const mockedRecordError = vi.mocked(recordError);

const VALID_USER = {
  id: '00000000-0000-0000-0000-000000000010',
  tenantId: '00000000-0000-0000-0000-000000000001',
  name: 'Tester',
  email: 't@example.com',
  systemRole: 'general' as const,
};

function postReq(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/chat/search', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedGetAuth.mockResolvedValue(VALID_USER);
  mockedTenantFind.mockResolvedValue({ seedDataEnabled: true } as never);
  mockedChatSearch.mockResolvedValue({
    query: '',
    degraded: false,
    results: { projects: [], knowledges: [], risksIssues: [], retrospectives: [], memos: [] },
    totalCount: 0,
  });
});

describe('POST /api/chat/search — 認証', () => {
  it('未認証なら 401', async () => {
    mockedGetAuth.mockResolvedValueOnce(
      NextResponse.json({ error: { code: 'UNAUTHORIZED' } }, { status: 401 }),
    );
    const res = await POST(postReq({ query: '工数膨張への対策' }));
    expect(res.status).toBe(401);
    expect(mockedChatSearch).not.toHaveBeenCalled();
  });

  it('セッション失効 (SESSION_INVALIDATED) も 401 を透過', async () => {
    mockedGetAuth.mockResolvedValueOnce(
      NextResponse.json({ error: { code: 'SESSION_INVALIDATED' } }, { status: 401 }),
    );
    const res = await POST(postReq({ query: 'q' }));
    expect(res.status).toBe(401);
  });
});

describe('POST /api/chat/search — 入力バリデーション', () => {
  it('JSON が壊れていれば 400 INVALID_JSON', async () => {
    const req = new NextRequest('http://localhost/api/chat/search', {
      method: 'POST',
      body: '{invalid json',
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('INVALID_JSON');
  });

  it('query が文字列でなければ 400 INVALID_QUERY', async () => {
    const res = await POST(postReq({ query: 123 }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('INVALID_QUERY');
  });

  it('query が 8000 字超過なら 400 QUERY_TOO_LONG', async () => {
    const longQuery = 'a'.repeat(8001);
    const res = await POST(postReq({ query: longQuery }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('QUERY_TOO_LONG');
  });

  it('query が空文字でも 200 を返す (検索結果は 0 件)', async () => {
    const res = await POST(postReq({ query: '' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.totalCount).toBe(0);
  });

  it('10 字未満でも 200 を返す (送信は常に可能、UI で警告表示)', async () => {
    mockedChatSearch.mockResolvedValueOnce({
      query: '工数',
      degraded: false,
      results: { projects: [], knowledges: [], risksIssues: [], retrospectives: [], memos: [] },
      totalCount: 0,
    });
    const res = await POST(postReq({ query: '工数' }));
    expect(res.status).toBe(200);
  });
});

describe('POST /api/chat/search — 正常系', () => {
  it('chatSemanticSearch にユーザ情報 + seedDataEnabled を渡す', async () => {
    mockedTenantFind.mockResolvedValueOnce({ seedDataEnabled: true } as never);
    await POST(postReq({ query: '工数膨張への対策' }));

    expect(mockedChatSearch).toHaveBeenCalledWith({
      query: '工数膨張への対策',
      viewerTenantId: VALID_USER.tenantId,
      viewerUserId: VALID_USER.id,
      viewerSeedDataEnabled: true,
    });
  });

  it('seedDataEnabled=false テナントは無効化を service に伝える', async () => {
    mockedTenantFind.mockResolvedValueOnce({ seedDataEnabled: false } as never);
    await POST(postReq({ query: '工数膨張への対策' }));

    expect(mockedChatSearch).toHaveBeenCalledWith(
      expect.objectContaining({ viewerSeedDataEnabled: false }),
    );
  });

  it('Tenant が見つからない場合は seedDataEnabled=true 扱い (既存提案機能と整合)', async () => {
    mockedTenantFind.mockResolvedValueOnce(null);
    await POST(postReq({ query: 'q' }));

    expect(mockedChatSearch).toHaveBeenCalledWith(
      expect.objectContaining({ viewerSeedDataEnabled: true }),
    );
  });

  it('結果を data フィールドに包んで返す', async () => {
    mockedChatSearch.mockResolvedValueOnce({
      query: 'q',
      degraded: false,
      results: {
        projects: [],
        knowledges: [
          { kind: 'knowledge', id: 'k-1', title: 'ナレッジA', snippet: 'snippet', score: 0.5, tier: 'strong', sourceProjectId: null, sourceProjectName: null, authorUserId: null },
        ],
        risksIssues: [],
        retrospectives: [],
        memos: [],
      },
      totalCount: 1,
    });

    const res = await POST(postReq({ query: 'q' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.totalCount).toBe(1);
    expect(body.data.results.knowledges).toHaveLength(1);
    expect(body.data.degraded).toBe(false);
  });

  it('chatSemanticSearch が例外を投げても 500 + 固定文言で応答 (stack trace を漏らさない)', async () => {
    mockedChatSearch.mockRejectedValueOnce(
      new Error('内部接続エラー at /node_modules/prisma/client.ts:1234:5 with password=secret123'),
    );

    const res = await POST(postReq({ query: '工数膨張への対策' }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('INTERNAL_ERROR');
    expect(body.error.message).toBe('検索に失敗しました。時間をおいて再度お試しください');

    // 機密情報 (stack / password / 内部パス) が response に含まれないこと
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('secret123');
    expect(serialized).not.toContain('/node_modules/');
    expect(serialized).not.toContain('client.ts');

    // recordError は呼ばれている (server side で詳細は秘匿保存)
    expect(mockedRecordError).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: 'error',
        source: 'server',
        userId: VALID_USER.id,
        context: expect.objectContaining({ kind: 'chat_search_unexpected_error', tenantId: VALID_USER.tenantId }),
      }),
    );

    // クエリ文字列は context に含まれない (機微情報の漏れ込み防止)
    const recordCallArg = mockedRecordError.mock.calls[0]?.[0];
    expect(recordCallArg?.context).not.toHaveProperty('query');
  });

  it('prisma.tenant.findUnique が失敗しても 500 で stack を漏らさない', async () => {
    mockedTenantFind.mockRejectedValueOnce(new Error('connection refused at postgresql://user:pw@host'));

    const res = await POST(postReq({ query: 'q' }));
    expect(res.status).toBe(500);
    const body = await res.json();
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('postgresql://');
    expect(serialized).not.toContain('pw');
  });

  it('縮退モード時は degraded=true と degradeReason を返す', async () => {
    mockedChatSearch.mockResolvedValueOnce({
      query: 'q',
      degraded: true,
      degradeReason: 'rate_limited',
      results: { projects: [], knowledges: [], risksIssues: [], retrospectives: [], memos: [] },
      totalCount: 0,
    });

    const res = await POST(postReq({ query: 'q' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.degraded).toBe(true);
    expect(body.data.degradeReason).toBe('rate_limited');
  });
});
