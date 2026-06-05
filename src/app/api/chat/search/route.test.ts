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
import { _resetRateLimitBucketsForTest } from '@/lib/rate-limit';

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
  // route が applyRateLimit を呼ぶため、テスト間で bucket を必ずクリアする。
  // 共有しないと前テストで消費したカウンタが次テストで 429 を誘発する。
  _resetRateLimitBucketsForTest();
  mockedGetAuth.mockResolvedValue(VALID_USER);
  mockedTenantFind.mockResolvedValue({ seedDataEnabled: true } as never);
  mockedChatSearch.mockResolvedValue({
    query: '',
    degraded: false,
    results: { projects: [], knowledges: [], risksIssues: [], retrospectives: [], memos: [], attachments: [] },
    totalCount: 0,
    fileScopeApplied: false,
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
      results: { projects: [], knowledges: [], risksIssues: [], retrospectives: [], memos: [], attachments: [] },
      totalCount: 0,
      fileScopeApplied: false,
    });
    const res = await POST(postReq({ query: '工数' }));
    expect(res.status).toBe(200);
  });
});

describe('POST /api/chat/search — 正常系', () => {
  // feat/starter-data-import (2026-06-05): 単一テナント化。チャット検索は自テナントのみを参照するため、
  //   旧 seedDataEnabled lookup / 受け渡しは撤去された (viewerSeedDataEnabled は service 引数から消滅)。
  it('chatSemanticSearch に自テナントのユーザ情報のみを渡す (seedDataEnabled なし)', async () => {
    await POST(postReq({ query: '工数膨張への対策' }));

    expect(mockedChatSearch).toHaveBeenCalledWith({
      query: '工数膨張への対策',
      viewerTenantId: VALID_USER.tenantId,
      viewerUserId: VALID_USER.id,
    });
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
        attachments: [],
      },
      totalCount: 1,
      fileScopeApplied: false,
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
    // PR fix/chat-search-and-auto-open: tenantId は top-level field (RecordErrorInput.tenantId)
    // に移動。context は kind のみ持つ。
    expect(mockedRecordError).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: 'error',
        source: 'server',
        userId: VALID_USER.id,
        tenantId: VALID_USER.tenantId,
        context: expect.objectContaining({ kind: 'chat_search_unexpected_error' }),
      }),
    );

    // クエリ文字列は context に含まれない (機微情報の漏れ込み防止)
    const recordCallArg = mockedRecordError.mock.calls[0]?.[0];
    expect(recordCallArg?.context).not.toHaveProperty('query');
  });

  it('縮退モード時は degraded=true と degradeReason を返す', async () => {
    mockedChatSearch.mockResolvedValueOnce({
      query: 'q',
      degraded: true,
      degradeReason: 'rate_limited',
      results: { projects: [], knowledges: [], risksIssues: [], retrospectives: [], memos: [], attachments: [] },
      totalCount: 0,
      fileScopeApplied: false,
    });

    const res = await POST(postReq({ query: 'q' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.degraded).toBe(true);
    expect(body.data.degradeReason).toBe('rate_limited');
  });
});

describe('POST /api/chat/search — IP レート制限 (PR fix/chat-search-and-auto-open)', () => {
  // 背景: 認証済ユーザが UI gate を迂回して連投すると、縮退モードの pg_trgm 経路は
  // withMeteredLLM の rate_limited で守られないため DB DoS が成立する。
  // route 側で applyRateLimit(key: 'chat-search', max: 30, windowMs: 60_000) を適用する。

  // ヘルパ: x-forwarded-for を持たせて bucket を明示分離可能にする
  function postReqWithIp(body: unknown, ip: string): NextRequest {
    return new NextRequest('http://localhost/api/chat/search', {
      method: 'POST',
      headers: { 'x-forwarded-for': ip },
      body: JSON.stringify(body),
    });
  }

  it('同一 IP から 30 リクエストまでは通過、31 回目で 429 を返す', async () => {
    const ip = '203.0.113.10';
    for (let i = 0; i < 30; i++) {
      const res = await POST(postReqWithIp({ query: 'q' }, ip));
      expect(res.status).toBe(200);
    }
    const overflow = await POST(postReqWithIp({ query: 'q' }, ip));
    expect(overflow.status).toBe(429);
    const body = await overflow.json();
    expect(body.error.code).toBe('TOO_MANY_REQUESTS');
  });

  it('別 IP からのリクエストは独立カウントされる', async () => {
    const ipA = '203.0.113.20';
    const ipB = '203.0.113.21';
    for (let i = 0; i < 30; i++) {
      await POST(postReqWithIp({ query: 'q' }, ipA));
    }
    // ipA は 30/30 で次は 429 だが、ipB は別 bucket なので通る
    const resB = await POST(postReqWithIp({ query: 'q' }, ipB));
    expect(resB.status).toBe(200);
  });

  it('未認証は rate limit を消費しない (認証チェックが先で安価に弾く)', async () => {
    mockedGetAuth.mockResolvedValue(
      NextResponse.json({ error: { code: 'UNAUTHORIZED' } }, { status: 401 }),
    );
    const ip = '203.0.113.30';
    // 50 回未認証アクセスしても rate limit に到達せず 401 を返し続ける
    for (let i = 0; i < 50; i++) {
      const res = await POST(postReqWithIp({ query: 'q' }, ip));
      expect(res.status).toBe(401);
    }
    // 認証成功した最初のリクエストは通る (rate limit カウンタが消費されていない証拠)
    mockedGetAuth.mockResolvedValue(VALID_USER);
    const res = await POST(postReqWithIp({ query: 'q' }, ip));
    expect(res.status).toBe(200);
  });
});

describe('POST /api/chat/search — error sanitize (PR fix/chat-search-and-auto-open)', () => {
  // 背景: Prisma / Voyage SDK が parameter/payload を error.message に含めるケースで、
  // ユーザのクエリ文字列 (機微情報の可能性あり) が自社 DB の error_log に保存される懸念。
  // sanitizeErrorForLog でクエリ verbatim を `[REDACTED_QUERY]` に置換する。

  it('error.message にクエリ文字列が含まれていれば redact してから recordError に渡す', async () => {
    const userQuery = '社外秘プロジェクト Alpha の進捗状況と課題';  // 10 字以上の機微クエリ
    mockedChatSearch.mockRejectedValueOnce(
      new Error(`Prisma query failed with params: { query: "${userQuery}" }`),
    );

    await POST(postReq({ query: userQuery }));

    const recordCallArg = mockedRecordError.mock.calls[0]?.[0];
    expect(recordCallArg).toBeDefined();
    // クエリ verbatim が message に含まれていない
    expect(recordCallArg?.message).not.toContain(userQuery);
    // 代わりに [REDACTED_QUERY] が含まれている
    expect(recordCallArg?.message).toContain('[REDACTED_QUERY]');
    // エラークラス名は trace 用に残す
    expect(recordCallArg?.message).toContain('Error:');
  });

  it('error.stack にクエリ文字列が含まれていれば redact してから recordError に渡す', async () => {
    const userQuery = '機密情報を含む長いクエリ文字列サンプル';
    const err = new Error('boom');
    err.stack = `Error: boom\n    at someFunc (line includes query: ${userQuery})\n    at next (file.ts:1:1)`;
    mockedChatSearch.mockRejectedValueOnce(err);

    await POST(postReq({ query: userQuery }));

    const recordCallArg = mockedRecordError.mock.calls[0]?.[0];
    expect(recordCallArg?.stack).toBeDefined();
    expect(recordCallArg?.stack).not.toContain(userQuery);
    expect(recordCallArg?.stack).toContain('[REDACTED_QUERY]');
  });

  it('短いクエリ (10 字未満) は false positive 回避のため redact しない', async () => {
    // 'abc' のような短い文字列を redact 対象にすると、message 内の普通の単語まで
    // 巻き添えで置換される false positive が起きる。defense-in-depth として 10 字未満は除外。
    const shortQuery = 'abc';
    mockedChatSearch.mockRejectedValueOnce(new Error(`error contains abc somewhere`));

    await POST(postReq({ query: shortQuery }));

    const recordCallArg = mockedRecordError.mock.calls[0]?.[0];
    expect(recordCallArg?.message).toContain('abc');
    expect(recordCallArg?.message).not.toContain('[REDACTED_QUERY]');
  });

  it('error.message が異常に長くても上限カット (DB / レビューア負荷防止)', async () => {
    const huge = 'X'.repeat(10000);
    mockedChatSearch.mockRejectedValueOnce(new Error(huge));

    await POST(postReq({ query: 'q' }));

    const recordCallArg = mockedRecordError.mock.calls[0]?.[0];
    // sanitize 上限 500 字 + 'Error: ' プレフィックスなので 600 字未満で収まる
    expect(recordCallArg?.message.length).toBeLessThan(600);
  });

  it('recordError の context.tenantId と top-level tenantId 両方に user.tenantId が入る', async () => {
    // tenantId は context (旧仕様) と top-level (新仕様) 両方に渡す。
    // 旧 system_error_logs の集計クエリと、新しい tenantId 別フィルタの両方を壊さない。
    mockedChatSearch.mockRejectedValueOnce(new Error('boom'));

    await POST(postReq({ query: 'q' }));

    const recordCallArg = mockedRecordError.mock.calls[0]?.[0];
    expect(recordCallArg?.tenantId).toBe(VALID_USER.tenantId);
  });
});
