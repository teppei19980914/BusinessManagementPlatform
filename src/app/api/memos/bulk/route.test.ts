/**
 * PR #162 Phase 2: 「全メモ」横断ビュー 一括 visibility 更新 API。
 * Memo は visibility 値域が private/public (Retrospective/Knowledge とは異なる)。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/auth', () => ({ auth: vi.fn() }));
vi.mock('@/services/memo.service', () => ({
  bulkUpdateMemosVisibilityFromCrossList: vi.fn(),
}));

import { PATCH } from './route';
import { auth } from '@/lib/auth';
import { bulkUpdateMemosVisibilityFromCrossList } from '@/services/memo.service';

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';

function makeReq(body: unknown): Request {
  return new Request('http://test/api/memos/bulk', {
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

describe('PATCH /api/memos/bulk', () => {
  it('Memo は visibility="draft" を拒否する (private/public のみ)', async () => {
    const res = await PATCH(makeReq({
      ids: [VALID_UUID],
      filterFingerprint: { keyword: 'a' },
      visibility: 'draft',
    }) as never);
    expect(res.status).toBe(400);
  });

  it('filterFingerprint 空 → 400 FILTER_REQUIRED', async () => {
    const res = await PATCH(makeReq({
      ids: [VALID_UUID],
      filterFingerprint: {},
      visibility: 'private',
    }) as never);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('FILTER_REQUIRED');
  });

  it('正常系: visibility=private で「全メモから取り下げ」', async () => {
    vi.mocked(bulkUpdateMemosVisibilityFromCrossList).mockResolvedValue({
      updatedIds: [VALID_UUID], skippedNotOwned: 0, skippedNotFound: 0,
    });
    const res = await PATCH(makeReq({
      ids: [VALID_UUID],
      filterFingerprint: { mineOnly: true },
      visibility: 'private',
    }) as never);
    expect(res.status).toBe(200);
    expect(bulkUpdateMemosVisibilityFromCrossList).toHaveBeenCalledWith(
      [VALID_UUID], 'private', 'u-1',
    );
  });
});
