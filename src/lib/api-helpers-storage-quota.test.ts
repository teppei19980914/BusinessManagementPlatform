/**
 * requireStorageQuotaForWrite ヘルパの単体テスト (2026-05-31 改修 / ADR-0030 累積ハードキャップ撤去)
 *
 * 検証観点:
 *   - 1 操作ペイロード上限 (DB_WRITE_PAYLOAD_MAX_BYTES = 5MB) 超過 → 413 PAYLOAD_TOO_LARGE
 *   - Beginner 無料枠 (50MB) 超過 → 403 BEGINNER_DB_QUOTA_EXCEEDED
 *   - 累積 50GB ハードキャップは撤去 (非 Beginner は上限なし)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  SI_GB_BYTES,
  DB_WRITE_PAYLOAD_MAX_BYTES,
  BEGINNER_DB_FREE_TIER_BYTES,
} from '@/config/db-capacity-pricing';

vi.mock('@/lib/auth', () => ({
  auth: vi.fn(),
}));

vi.mock('@/lib/permissions', () => ({
  checkPermission: vi.fn(),
  checkMembership: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    tenant: {
      findFirst: vi.fn(),
    },
  },
}));

import { prisma } from '@/lib/db';
import { requireStorageQuotaForWrite } from './api-helpers';

const TENANT_ID = 'tenant-uuid-1';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('requireStorageQuotaForWrite — 1 操作ペイロード上限 (5MB)', () => {
  it('5MB ちょうど → null (= 続行)', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce({
      plan: 'expert',
      storageBytesUsed: BigInt(0),
    } as never);

    const r = await requireStorageQuotaForWrite(TENANT_ID, DB_WRITE_PAYLOAD_MAX_BYTES);
    expect(r).toBeNull();
  });

  it('5MB 超過 → 413 PAYLOAD_TOO_LARGE (Beginner / tenant 参照より前に弾く)', async () => {
    const r = await requireStorageQuotaForWrite(TENANT_ID, DB_WRITE_PAYLOAD_MAX_BYTES + 1);
    expect(r).not.toBeNull();
    if (r) {
      expect(r.status).toBe(413);
      const body = await r.json();
      expect(body.error.code).toBe('PAYLOAD_TOO_LARGE');
      expect(body.error.limitBytes).toBe(DB_WRITE_PAYLOAD_MAX_BYTES);
    }
    // payload ガードは tenant 参照前に弾くため findFirst は呼ばれない
    expect(prisma.tenant.findFirst).not.toHaveBeenCalled();
  });
});

describe('requireStorageQuotaForWrite — 累積ハードキャップ撤去 (非 Beginner は上限なし)', () => {
  it('非 Beginner: 使用 60GB (旧 50GB ハードキャップ超) → null (累積上限なし)', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce({
      plan: 'expert',
      storageBytesUsed: BigInt(60 * SI_GB_BYTES),
    } as never);

    const r = await requireStorageQuotaForWrite(TENANT_ID, 1000);
    expect(r).toBeNull();
  });

  it('estimatedBytes 省略時も非 Beginner は null (= 累積上限なし)', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce({
      plan: 'pro',
      storageBytesUsed: BigInt(51 * SI_GB_BYTES),
    } as never);

    const r = await requireStorageQuotaForWrite(TENANT_ID);
    expect(r).toBeNull();
  });
});

// ================================================================
// ADR-0025 (2026-05-29): Beginner プラン専用エラーレスポンス (維持)
// ================================================================

describe('requireStorageQuotaForWrite — ADR-0025 Beginner プラン分岐', () => {
  it('Beginner × 50MB 超過 → 403 BEGINNER_DB_QUOTA_EXCEEDED + 専用文言 + upgradeUrl', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce({
      plan: 'beginner',
      storageBytesUsed: BigInt(BEGINNER_DB_FREE_TIER_BYTES + 1000),
    } as never);

    const r = await requireStorageQuotaForWrite(TENANT_ID, 0);
    expect(r).not.toBeNull();
    if (r) {
      expect(r.status).toBe(403);
      const body = await r.json();
      expect(body.error.code).toBe('BEGINNER_DB_QUOTA_EXCEEDED');
      expect(body.error.quotaType).toBe('db');
      expect(body.error.message).toContain('Beginner');
      expect(body.error.message).toContain('Expert');
      expect(body.error.upgradeUrl).toBe('/settings/tenant');
      expect(body.error.limitBytes).toBe(BEGINNER_DB_FREE_TIER_BYTES);
    }
  });

  it('Expert × 50MB 超過 → null (= Beginner ガード対象外、累積上限なし)', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce({
      plan: 'expert',
      storageBytesUsed: BigInt(BEGINNER_DB_FREE_TIER_BYTES + 1000),
    } as never);

    const r = await requireStorageQuotaForWrite(TENANT_ID, 0);
    expect(r).toBeNull();
  });

  it('Pro × 50MB 超過 → null (Beginner ガード対象外)', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce({
      plan: 'pro',
      storageBytesUsed: BigInt(BEGINNER_DB_FREE_TIER_BYTES + 1000),
    } as never);

    const r = await requireStorageQuotaForWrite(TENANT_ID, 0);
    expect(r).toBeNull();
  });
});
