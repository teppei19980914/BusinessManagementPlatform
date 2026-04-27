/**
 * PR #162 Phase 2: 「全振り返り」横断ビュー 一括 visibility 更新 API。
 * 検証観点: FILTER_REQUIRED 二重防御 / validation / 正常系。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/auth', () => ({ auth: vi.fn() }));
vi.mock('@/services/retrospective.service', () => ({
  bulkUpdateRetrospectivesVisibilityFromCrossList: vi.fn(),
}));

import { PATCH } from './route';
import { auth } from '@/lib/auth';
import { bulkUpdateRetrospectivesVisibilityFromCrossList } from '@/services/retrospective.service';

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';

function makeReq(body: unknown): Request {
  return new Request('http://test/api/retrospectives/bulk', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth).mockResolvedValue({
    user: { id: 'u-1', name: 'A', email: 'a@x.co', systemRole: 'general' },
  } as never);
});

describe('PATCH /api/retrospectives/bulk', () => {
  it('未認証なら 401', async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const res = await PATCH(makeReq({
      ids: [VALID_UUID],
      filterFingerprint: { keyword: 'a' },
      visibility: 'draft',
    }) as never);
    expect(res.status).toBe(401);
  });

  it('UUID 不正は 400', async () => {
    const res = await PATCH(makeReq({
      ids: ['not-uuid'],
      filterFingerprint: { keyword: 'a' },
      visibility: 'draft',
    }) as never);
    expect(res.status).toBe(400);
  });

  it('visibility が enum 外なら 400 (Retrospective は draft/public のみ)', async () => {
    const res = await PATCH(makeReq({
      ids: [VALID_UUID],
      filterFingerprint: { keyword: 'a' },
      visibility: 'private',
    }) as never);
    expect(res.status).toBe(400);
  });

  it('filterFingerprint 空なら 400 FILTER_REQUIRED', async () => {
    const res = await PATCH(makeReq({
      ids: [VALID_UUID],
      filterFingerprint: {},
      visibility: 'draft',
    }) as never);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('FILTER_REQUIRED');
  });

  it('keyword 空白のみは 400 FILTER_REQUIRED', async () => {
    const res = await PATCH(makeReq({
      ids: [VALID_UUID],
      filterFingerprint: { keyword: '   ' },
      visibility: 'draft',
    }) as never);
    expect(res.status).toBe(400);
  });

  it('mineOnly=true で 200 (mineOnly はフィルター扱い)', async () => {
    vi.mocked(bulkUpdateRetrospectivesVisibilityFromCrossList).mockResolvedValue({
      updatedIds: [VALID_UUID], skippedNotOwned: 0, skippedNotFound: 0,
    });
    const res = await PATCH(makeReq({
      ids: [VALID_UUID],
      filterFingerprint: { mineOnly: true },
      visibility: 'public',
    }) as never);
    expect(res.status).toBe(200);
    expect(bulkUpdateRetrospectivesVisibilityFromCrossList).toHaveBeenCalledWith(
      [VALID_UUID], 'public', 'u-1',
    );
  });

  it('keyword 適用の正常系で skippedNotOwned を含む結果を 200 で返す', async () => {
    vi.mocked(bulkUpdateRetrospectivesVisibilityFromCrossList).mockResolvedValue({
      updatedIds: [VALID_UUID], skippedNotOwned: 2, skippedNotFound: 1,
    });
    const res = await PATCH(makeReq({
      ids: [VALID_UUID],
      filterFingerprint: { keyword: 'foo' },
      visibility: 'draft',
    }) as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.skippedNotOwned).toBe(2);
    expect(body.data.skippedNotFound).toBe(1);
  });
});
