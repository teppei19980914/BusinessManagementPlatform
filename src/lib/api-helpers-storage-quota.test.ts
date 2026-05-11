/**
 * requireStorageQuotaForWrite ヘルパの単体テスト (PR-5 / 2026-05-15)
 *
 * 検証観点:
 *   - 上限内なら null を返す (= 続行 OK)
 *   - 上限超過なら 403 STORAGE_LIMIT_EXCEEDED の NextResponse を返す
 *   - 超過 response の body にキャッシュ値・上限・プラン名が含まれる
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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
const ONE_MB = 1024 * 1024;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('requireStorageQuotaForWrite', () => {
  it('Standard 20MB 内 (使用 10MB + 追加 5MB) → null', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce({
      storageAddonPlan: 'standard',
      storageBytesUsed: BigInt(10 * ONE_MB),
    } as never);

    const r = await requireStorageQuotaForWrite(TENANT_ID, 5 * ONE_MB);
    expect(r).toBeNull();
  });

  it('Standard 20MB 超過 (使用 15MB + 追加 10MB) → 403 STORAGE_LIMIT_EXCEEDED', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce({
      storageAddonPlan: 'standard',
      storageBytesUsed: BigInt(15 * ONE_MB),
    } as never);

    const r = await requireStorageQuotaForWrite(TENANT_ID, 10 * ONE_MB);
    expect(r).not.toBeNull();
    if (r) {
      expect(r.status).toBe(403);
      const body = await r.json();
      expect(body.error.code).toBe('STORAGE_LIMIT_EXCEEDED');
      expect(body.error.limitBytes).toBe(20 * ONE_MB);
      expect(body.error.addonPlan).toBe('standard');
    }
  });

  it('Plus 220MB 内 (使用 100MB + 追加 50MB) → null', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce({
      storageAddonPlan: 'plus',
      storageBytesUsed: BigInt(100 * ONE_MB),
    } as never);

    const r = await requireStorageQuotaForWrite(TENANT_ID, 50 * ONE_MB);
    expect(r).toBeNull();
  });

  it('estimatedBytes 省略時はキャッシュ値のみで判定 (= 既に超過のテナントを弾く)', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce({
      storageAddonPlan: 'standard',
      storageBytesUsed: BigInt(25 * ONE_MB), // 既に 20MB 超過
    } as never);

    const r = await requireStorageQuotaForWrite(TENANT_ID);
    expect(r).not.toBeNull();
    if (r) expect(r.status).toBe(403);
  });

  it('境界値: 使用 + 追加 = 上限ちょうど → null (= 許可)', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce({
      storageAddonPlan: 'standard',
      storageBytesUsed: BigInt(15 * ONE_MB),
    } as never);

    // 15MB + 5MB = 20MB ちょうど → 許可
    const r = await requireStorageQuotaForWrite(TENANT_ID, 5 * ONE_MB);
    expect(r).toBeNull();
  });

  it('境界値: 使用 + 追加 = 上限 + 1byte → 403', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce({
      storageAddonPlan: 'standard',
      storageBytesUsed: BigInt(15 * ONE_MB),
    } as never);

    // 15MB + 5MB + 1 = 20MB + 1 → 拒否
    const r = await requireStorageQuotaForWrite(TENANT_ID, 5 * ONE_MB + 1);
    expect(r).not.toBeNull();
  });
});
