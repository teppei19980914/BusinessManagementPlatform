/**
 * ADR-0016 (2026-05-20): check-tenant-eligibility API テスト。
 *
 * 検証観点:
 *   - 過去/現役テナントの billingContactEmail に該当 → beginnerAvailable=false
 *   - 既登録 user.email に該当 → beginnerAvailable=false
 *   - 該当なし → beginnerAvailable=true
 *   - バリデーション失敗 → beginnerAvailable=true (UI ヒント無効化)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  prisma: {
    tenant: { findMany: vi.fn() },
    user: { findFirst: vi.fn() },
  },
}));

import { POST } from './route';
import { prisma } from '@/lib/db';
import { _resetRateLimitBucketsForTest } from '@/lib/rate-limit';

function makeReq(body: unknown): Request {
  return new Request('http://test/api/auth/check-tenant-eligibility', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/auth/check-tenant-eligibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetRateLimitBucketsForTest();
    vi.mocked(prisma.tenant.findMany).mockResolvedValue([]);
    vi.mocked(prisma.user.findFirst).mockResolvedValue(null);
  });

  it('該当なし → beginnerAvailable=true', async () => {
    const res = await POST(
      makeReq({
        billingContactEmail: 'new@example.com',
        initialAdminEmail: 'admin@example.com',
      }) as never,
    );
    const body = await res.json();
    expect(body.beginnerAvailable).toBe(true);
    expect(body.reason).toBe('none');
  });

  it('過去/現役テナントの billingContactEmail 該当 → beginnerAvailable=false', async () => {
    vi.mocked(prisma.tenant.findMany).mockResolvedValueOnce([{ id: 'past-tenant' }] as never);

    const res = await POST(
      makeReq({
        billingContactEmail: 'billing@example.com',
        initialAdminEmail: 'admin@example.com',
      }) as never,
    );
    const body = await res.json();
    expect(body.beginnerAvailable).toBe(false);
    expect(body.reason).toBe('past_email_found');
    expect(body.message).toContain('Expert');
  });

  it('既登録 user.email 該当 → beginnerAvailable=false', async () => {
    vi.mocked(prisma.user.findFirst).mockResolvedValue({ id: 'existing-user' } as never);

    const res = await POST(
      makeReq({
        billingContactEmail: 'new@example.com',
        initialAdminEmail: 'admin@example.com',
      }) as never,
    );
    const body = await res.json();
    expect(body.beginnerAvailable).toBe(false);
  });

  it('バリデーション失敗 (email 形式不正) → beginnerAvailable=true (UI ヒント無効化)', async () => {
    const res = await POST(
      makeReq({
        billingContactEmail: 'not-an-email',
        initialAdminEmail: 'admin@example.com',
      }) as never,
    );
    const body = await res.json();
    expect(body.beginnerAvailable).toBe(true);
    expect(prisma.tenant.findMany).not.toHaveBeenCalled();
  });

  it('JSON 欠落でも 500 ではなく beginnerAvailable=true を返す', async () => {
    const req = new Request('http://test/api/auth/check-tenant-eligibility', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    });
    const res = await POST(req as never);
    const body = await res.json();
    expect(body.beginnerAvailable).toBe(true);
  });
});
