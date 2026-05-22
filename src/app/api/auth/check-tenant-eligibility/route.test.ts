/**
 * ADR-0016 Revised (2026-05-22): check-tenant-eligibility API テスト (3 値返却)。
 *
 * 検証観点:
 *   - 層 1 (signupAllowed=false, reason='owned'): 自前テナント保有 (= 公開フォーム完全不可)
 *   - 層 2 (beginnerAvailable=false, reason='past_email_found'): 招待 / Default 所属のみ (= Beginner 不可)
 *   - 層 3 (両方 true, reason='none'): 完全な新規 (= 全プラン可)
 *   - バリデーション失敗 → 両方 true (UI ヒント無効化、サーバ層が defense-in-depth)
 *   - 判定キーは initialAdminEmail のみ。billingContactEmail は対象外
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  prisma: {
    tenant: { findFirst: vi.fn() },
    user: { findMany: vi.fn() },
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

describe('POST /api/auth/check-tenant-eligibility (ADR-0016 Revised / 3 層判定)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetRateLimitBucketsForTest();
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.user.findMany).mockResolvedValue([]);
  });

  it('層 3: users.email = initialAdminEmail が無ければ signupAllowed=true, beginnerAvailable=true', async () => {
    const res = await POST(
      makeReq({ initialAdminEmail: 'admin@new-customer.example' }) as never,
    );
    const body = await res.json();
    expect(body.signupAllowed).toBe(true);
    expect(body.beginnerAvailable).toBe(true);
    expect(body.reason).toBe('none');
  });

  it('層 2: 招待 / Default 所属のみなら signupAllowed=true, beginnerAvailable=false (past_email_found)', async () => {
    vi.mocked(prisma.user.findMany).mockResolvedValueOnce([
      { id: 'member-user' },
    ] as never);
    vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce(null); // 層 1 該当なし

    const res = await POST(
      makeReq({ initialAdminEmail: 'admin@member.example' }) as never,
    );
    const body = await res.json();
    expect(body.signupAllowed).toBe(true);
    expect(body.beginnerAvailable).toBe(false);
    expect(body.reason).toBe('past_email_found');
    expect(body.message).toContain('Expert');
  });

  it('層 1: 自前テナント保有なら signupAllowed=false, beginnerAvailable=false (owned)', async () => {
    vi.mocked(prisma.user.findMany).mockResolvedValueOnce([
      { id: 'creator-user' },
    ] as never);
    vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce({
      id: 'owned-tenant',
    } as never);

    const res = await POST(
      makeReq({ initialAdminEmail: 'admin@owner.example' }) as never,
    );
    const body = await res.json();
    expect(body.signupAllowed).toBe(false);
    expect(body.beginnerAvailable).toBe(false);
    expect(body.reason).toBe('owned');
    expect(body.message).toContain('システム管理者');
  });

  it('billingContactEmail は受信しても判定対象外 (= initialAdminEmail のみで判定)', async () => {
    // billingContactEmail を渡しても、user.findMany は initialAdminEmail のみで呼ばれる
    await POST(
      makeReq({
        billingContactEmail: 'billing@example.com',
        initialAdminEmail: 'admin@new.example',
      }) as never,
    );
    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { email: 'admin@new.example' },
      }),
    );
  });

  it('バリデーション失敗 (email 形式不正) → 両方 true (UI ヒント無効化)', async () => {
    const res = await POST(
      makeReq({ initialAdminEmail: 'not-an-email' }) as never,
    );
    const body = await res.json();
    expect(body.signupAllowed).toBe(true);
    expect(body.beginnerAvailable).toBe(true);
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });

  it('JSON 欠落でも 500 ではなく両方 true を返す', async () => {
    const req = new Request('http://test/api/auth/check-tenant-eligibility', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    });
    const res = await POST(req as never);
    const body = await res.json();
    expect(body.signupAllowed).toBe(true);
    expect(body.beginnerAvailable).toBe(true);
  });
});
