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
    // ADR-0016 (2026-05-20): tenant.findFirst (slug → id 解決) を追加 mock
    tenant: { findFirst: vi.fn() },
    user: { findFirst: vi.fn() },
  },
}));

import { POST } from './route';
import { prisma } from '@/lib/db';
import { _resetRateLimitBucketsForTest } from '@/lib/rate-limit';

// ADR-0016 (2026-05-20): tenantSlug 必須化に伴い、各テスト共通の helper
function makeReq(body: unknown): Request {
  // ADR-0016: tenantSlug が未指定の場合は 'tenant-a' を補完
  //   既存テストは email/status のみを assert しているため、tenantSlug は固定値で十分。
  const finalBody =
    typeof body === 'object' && body !== null && !('tenantSlug' in (body as object))
      ? { ...(body as object), tenantSlug: 'tenant-a' }
      : body;
  return new Request('http://test/api/auth/lock-status', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(finalBody),
  });
}

// ADR-0016: tenant 検索成功を共通 mock 化
function mockTenantFound() {
  vi.mocked(prisma.tenant.findFirst).mockResolvedValue({ id: 'tenant-A' } as never);
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

  // ADR-0016 (2026-05-20): tenantSlug が無効な場合も enumeration 防止のため status=none
  it('tenant が存在しないと status=none を返す (enumeration 防止)', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue(null);
    const res = await POST(makeReq({ email: 'a@b.co', tenantSlug: 'nonexistent' }) as never);
    const body = await res.json();
    expect(body.status).toBe('none');
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
  });

  it('存在しないメールアドレスは status=none を返す (enumeration 防止)', async () => {
    mockTenantFound();
    vi.mocked(prisma.user.findFirst).mockResolvedValue(null);
    const res = await POST(makeReq({ email: 'nobody@example.com' }) as never);
    const body = await res.json();
    expect(body.status).toBe('none');
  });

  it('ロックされていない既存ユーザは status=none を返す', async () => {
    mockTenantFound();
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
    mockTenantFound();
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
    mockTenantFound();
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
    mockTenantFound();
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
    mockTenantFound();
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
    mockTenantFound();
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
    mockTenantFound();
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
    mockTenantFound();
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
