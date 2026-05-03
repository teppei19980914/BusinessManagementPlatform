/**
 * PR #87: ログインロック状態参照 API のテスト。
 *
 * セキュリティ観点:
 *   - 存在しないメールアドレス / バリデーション失敗は常に 'none' を返す (enumeration 防止)
 *   - 存在するがロックされていないユーザも 'none'
 *   - 永続ロック → 'permanent_lock'
 *   - 一時ロック (有効期限内) → 'temporary_lock' + unlockAt
 *   - 一時ロック (期限切れ) → 'none'
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findFirst: vi.fn() },
  },
}));

import { POST } from './route';
import { prisma } from '@/lib/db';
import { _resetRateLimitBucketsForTest } from '@/lib/rate-limit';

function makeReq(body: unknown): Request {
  return new Request('http://test/api/auth/lock-status', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/auth/lock-status', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // PR fix/login-failure: テスト数増加で rate-limit (10 req/5min) に達するため
    // 各テスト前に bucket をクリアする。
    _resetRateLimitBucketsForTest();
  });

  it('バリデーション失敗 (email 形式不正) は status=none を返す', async () => {
    const res = await POST(makeReq({ email: 'not-an-email' }) as never);
    const body = await res.json();
    expect(body.status).toBe('none');
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
  });

  it('JSON 欠落でも status=none を返す (500 にしない)', async () => {
    const req = new Request('http://test/api/auth/lock-status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    });
    const res = await POST(req as never);
    const body = await res.json();
    expect(body.status).toBe('none');
  });

  it('存在しないメールアドレスは status=none を返す (enumeration 防止)', async () => {
    vi.mocked(prisma.user.findFirst).mockResolvedValue(null);
    const res = await POST(makeReq({ email: 'nobody@example.com' }) as never);
    const body = await res.json();
    expect(body.status).toBe('none');
  });

  it('ロックされていない既存ユーザは status=none を返す', async () => {
    vi.mocked(prisma.user.findFirst).mockResolvedValue({
      permanentLock: false,
      lockedUntil: null,
      isActive: true,
    } as never);
    const res = await POST(makeReq({ email: 'a@b.co' }) as never);
    const body = await res.json();
    expect(body.status).toBe('none');
  });

  // PR fix/login-failure (2026-05-03): 非活性ユーザを 'inactive' で報告。
  //   これまで is_active=false ユーザは「パスワード間違い」と誤表示され、
  //   本人が原因に気付けない UX バグの修正。
  it('is_active=false (非活性) は status=inactive を返す', async () => {
    vi.mocked(prisma.user.findFirst).mockResolvedValue({
      permanentLock: false,
      lockedUntil: null,
      isActive: false,
    } as never);
    const res = await POST(makeReq({ email: 'a@b.co' }) as never);
    const body = await res.json();
    expect(body.status).toBe('inactive');
  });

  it('永続ロックは inactive より優先される', async () => {
    vi.mocked(prisma.user.findFirst).mockResolvedValue({
      permanentLock: true,
      lockedUntil: null,
      isActive: false,
    } as never);
    const res = await POST(makeReq({ email: 'a@b.co' }) as never);
    const body = await res.json();
    expect(body.status).toBe('permanent_lock');
  });

  it('一時ロックは inactive より優先される', async () => {
    vi.mocked(prisma.user.findFirst).mockResolvedValue({
      permanentLock: false,
      lockedUntil: new Date(Date.now() + 60 * 60 * 1000),
      isActive: false,
    } as never);
    const res = await POST(makeReq({ email: 'a@b.co' }) as never);
    const body = await res.json();
    expect(body.status).toBe('temporary_lock');
  });

  it('永続ロック中は status=permanent_lock', async () => {
    vi.mocked(prisma.user.findFirst).mockResolvedValue({
      permanentLock: true,
      lockedUntil: null,
      isActive: true,
    } as never);
    const res = await POST(makeReq({ email: 'a@b.co' }) as never);
    const body = await res.json();
    expect(body.status).toBe('permanent_lock');
  });

  it('一時ロック (期限内) は status=temporary_lock + unlockAt (ISO)', async () => {
    const until = new Date(Date.now() + 30 * 60 * 1000);
    vi.mocked(prisma.user.findFirst).mockResolvedValue({
      permanentLock: false,
      lockedUntil: until,
      isActive: true,
    } as never);
    const res = await POST(makeReq({ email: 'a@b.co' }) as never);
    const body = await res.json();
    expect(body.status).toBe('temporary_lock');
    expect(body.unlockAt).toBe(until.toISOString());
  });

  it('一時ロック期限が過ぎていれば status=none', async () => {
    vi.mocked(prisma.user.findFirst).mockResolvedValue({
      permanentLock: false,
      lockedUntil: new Date(Date.now() - 60 * 1000),
      isActive: true,
    } as never);
    const res = await POST(makeReq({ email: 'a@b.co' }) as never);
    const body = await res.json();
    expect(body.status).toBe('none');
  });

  it('永続ロックが一時ロックより優先される', async () => {
    vi.mocked(prisma.user.findFirst).mockResolvedValue({
      permanentLock: true,
      lockedUntil: new Date(Date.now() + 60 * 60 * 1000),
      isActive: true,
    } as never);
    const res = await POST(makeReq({ email: 'a@b.co' }) as never);
    const body = await res.json();
    expect(body.status).toBe('permanent_lock');
    expect(body.unlockAt).toBeUndefined();
  });
});
