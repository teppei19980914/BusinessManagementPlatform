/**
 * PR #161 (feat/cross-list-bulk-update): 「全リスク / 全課題」一括更新 API の検証。
 *
 * 検証観点:
 *   - フィルター未適用 (filterFingerprint が空) なら 400 (FILTER_REQUIRED) で拒否
 *     → サーバ側でも全件更新の事故を防ぐ二重防御 (UI のチェックボックス無効化だけでは
 *        API 直叩きで bypass できるため)
 *   - validation エラー (no-op patch / UUID 不正等) は 400 で返す
 *   - 正常系は service 層に処理を委譲し result をそのまま返す
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/auth', () => ({ auth: vi.fn() }));
vi.mock('@/services/risk.service', () => ({
  bulkUpdateRisksFromCrossList: vi.fn(),
}));

import { PATCH } from './route';
import { auth } from '@/lib/auth';
import { bulkUpdateRisksFromCrossList } from '@/services/risk.service';

function makeReq(body: unknown): Request {
  return new Request('http://test/api/risks/bulk', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth).mockResolvedValue({
    user: { id: 'u-1', name: 'A', email: 'a@x.co', systemRole: 'general' },
  } as never);
});

describe('PATCH /api/risks/bulk', () => {
  it('未認証なら 401', async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const res = await PATCH(makeReq({ ids: [VALID_UUID], filterFingerprint: { type: 'risk' }, patch: { state: 'open' } }) as never);
    expect(res.status).toBe(401);
    expect(bulkUpdateRisksFromCrossList).not.toHaveBeenCalled();
  });

  it('JSON が壊れていれば 400', async () => {
    const req = new Request('http://test/api/risks/bulk', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: '{ not json',
    });
    const res = await PATCH(req as never);
    expect(res.status).toBe(400);
  });

  it('schema validation 失敗 (UUID 不正) は 400', async () => {
    const res = await PATCH(makeReq({
      ids: ['not-uuid'],
      filterFingerprint: { type: 'risk' },
      patch: { state: 'open' },
    }) as never);
    expect(res.status).toBe(400);
    expect(bulkUpdateRisksFromCrossList).not.toHaveBeenCalled();
  });

  it('patch がすべて省略 (no-op) は 400', async () => {
    const res = await PATCH(makeReq({
      ids: [VALID_UUID],
      filterFingerprint: { type: 'risk' },
      patch: {},
    }) as never);
    expect(res.status).toBe(400);
    expect(bulkUpdateRisksFromCrossList).not.toHaveBeenCalled();
  });

  it('フィルター未適用 (filterFingerprint が完全に空) なら 400 FILTER_REQUIRED', async () => {
    const res = await PATCH(makeReq({
      ids: [VALID_UUID],
      filterFingerprint: {},
      patch: { state: 'open' },
    }) as never);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('FILTER_REQUIRED');
    expect(bulkUpdateRisksFromCrossList).not.toHaveBeenCalled();
  });

  it('keyword が空白のみなら filterFingerprint としてカウントされず 400', async () => {
    const res = await PATCH(makeReq({
      ids: [VALID_UUID],
      filterFingerprint: { keyword: '   ' },
      patch: { state: 'open' },
    }) as never);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('FILTER_REQUIRED');
  });

  it('type フィルターのみ (タブ選択 = 暗黙のフィルター) なら通る', async () => {
    vi.mocked(bulkUpdateRisksFromCrossList).mockResolvedValue({
      updatedIds: [VALID_UUID],
      skippedNotOwned: 0,
      skippedNotFound: 0,
    });

    const res = await PATCH(makeReq({
      ids: [VALID_UUID],
      filterFingerprint: { type: 'risk' },
      patch: { state: 'in_progress' },
    }) as never);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.updatedIds).toEqual([VALID_UUID]);
    expect(bulkUpdateRisksFromCrossList).toHaveBeenCalledWith(
      [VALID_UUID],
      { state: 'in_progress' },
      'u-1',
    );
  });

  it('state フィルター適用 + assigneeId クリアの正常系', async () => {
    vi.mocked(bulkUpdateRisksFromCrossList).mockResolvedValue({
      updatedIds: [VALID_UUID],
      skippedNotOwned: 0,
      skippedNotFound: 0,
    });

    const res = await PATCH(makeReq({
      ids: [VALID_UUID],
      filterFingerprint: { state: 'open' },
      patch: { assigneeId: null },
    }) as never);

    expect(res.status).toBe(200);
    const callArgs = vi.mocked(bulkUpdateRisksFromCrossList).mock.calls[0][1];
    expect(callArgs.assigneeId).toBe(null);
  });

  it('skippedNotOwned > 0 でも 200 で返す (silent skip 仕様)', async () => {
    vi.mocked(bulkUpdateRisksFromCrossList).mockResolvedValue({
      updatedIds: [],
      skippedNotOwned: 3,
      skippedNotFound: 0,
    });

    const res = await PATCH(makeReq({
      ids: [VALID_UUID],
      filterFingerprint: { type: 'issue' },
      patch: { state: 'resolved' },
    }) as never);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.skippedNotOwned).toBe(3);
  });
});
