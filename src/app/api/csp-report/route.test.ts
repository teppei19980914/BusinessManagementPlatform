/**
 * /api/csp-report 単体テスト (security/phase-1, 2026-05-31)
 *
 * 検証ポイント:
 *   1. 正常な CSP violation report を受信し system_error_logs に記録、204 を返す
 *   2. malformed JSON でも 204 で打ち切る (browser は応答を気にしない仕様)
 *   3. rate limit 超過時はそのまま 429 を返す
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

vi.mock('@/lib/rate-limit', () => ({
  applyRateLimit: vi.fn(),
}));
vi.mock('@/services/error-log.service', () => ({
  recordError: vi.fn(async () => {}),
}));

import { applyRateLimit } from '@/lib/rate-limit';
import { recordError } from '@/services/error-log.service';
import { POST } from './route';

const buildReq = (body: BodyInit | null, contentType = 'application/csp-report') =>
  new NextRequest('http://localhost/api/csp-report', {
    method: 'POST',
    headers: { 'content-type': contentType },
    body,
  });

describe('/api/csp-report POST', () => {
  beforeEach(() => {
    vi.mocked(applyRateLimit).mockReturnValue(null);
    vi.mocked(recordError).mockClear();
  });

  it('正常な CSP violation report を受信して 204 と system_error_logs 記録を返す', async () => {
    const cspReport = {
      'document-uri': 'http://localhost/',
      'violated-directive': "script-src 'self'",
      'blocked-uri': 'inline',
    };
    const res = await POST(buildReq(JSON.stringify({ 'csp-report': cspReport })));

    expect(res.status).toBe(204);
    expect(recordError).toHaveBeenCalledTimes(1);
    expect(recordError).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: 'warn',
        source: 'client',
        context: expect.objectContaining({ kind: 'csp_violation', cspReport }),
      }),
    );
  });

  it('malformed JSON でも 204 で打ち切り (recordError は呼ばれない)', async () => {
    const res = await POST(buildReq('not a json body'));

    expect(res.status).toBe(204);
    expect(recordError).not.toHaveBeenCalled();
  });

  it('csp-report ラッパが無い root object 形式でも記録する (fallback)', async () => {
    const root = { 'document-uri': 'http://localhost/' };
    const res = await POST(buildReq(JSON.stringify(root)));

    expect(res.status).toBe(204);
    expect(recordError).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({ kind: 'csp_violation', cspReport: root }),
      }),
    );
  });

  it('rate limit 超過時はそのまま 429 を返し recordError は呼ばれない', async () => {
    vi.mocked(applyRateLimit).mockReturnValueOnce(
      NextResponse.json({ error: 'rate limit' }, { status: 429 }),
    );
    const res = await POST(buildReq(JSON.stringify({ 'csp-report': {} })));

    expect(res.status).toBe(429);
    expect(recordError).not.toHaveBeenCalled();
  });
});
