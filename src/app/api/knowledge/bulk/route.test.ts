/**
 * PR #162 Phase 2: 「全ナレッジ」横断ビュー 一括 visibility 更新 API。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/auth', () => ({ auth: vi.fn() }));
vi.mock('@/services/knowledge.service', () => ({
  bulkUpdateKnowledgeVisibilityFromCrossList: vi.fn(),
}));

import { PATCH } from './route';
import { auth } from '@/lib/auth';
import { bulkUpdateKnowledgeVisibilityFromCrossList } from '@/services/knowledge.service';

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';

function makeReq(body: unknown): Request {
  return new Request('http://test/api/knowledge/bulk', {
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

describe('PATCH /api/knowledge/bulk', () => {
  it('filterFingerprint 空 → 400 FILTER_REQUIRED', async () => {
    const res = await PATCH(makeReq({
      ids: [VALID_UUID],
      filterFingerprint: {},
      visibility: 'draft',
    }) as never);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('FILTER_REQUIRED');
  });

  it('正常系: keyword 適用 + visibility=draft', async () => {
    vi.mocked(bulkUpdateKnowledgeVisibilityFromCrossList).mockResolvedValue({
      updatedIds: [VALID_UUID], skippedNotOwned: 0, skippedNotFound: 0,
    });
    const res = await PATCH(makeReq({
      ids: [VALID_UUID],
      filterFingerprint: { keyword: 'react' },
      visibility: 'draft',
    }) as never);
    expect(res.status).toBe(200);
    expect(bulkUpdateKnowledgeVisibilityFromCrossList).toHaveBeenCalledWith(
      [VALID_UUID], 'draft', 'u-1',
    );
  });
});
