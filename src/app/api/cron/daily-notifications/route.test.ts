import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/services/notification.service', () => ({
  generateDailyNotifications: vi.fn(),
  cleanupReadNotifications: vi.fn(),
}));

vi.mock('@/services/external-data-import.service', () => ({
  deleteExpiredPreviews: vi.fn(),
}));

// ADR-0020 (2026-05-25): checkAndStartGracePeriod は廃止 (= write 拒否は 50GB ハードキャップ一本化)
// 5 回目検証 R で追加: detectDbCapacityDrift も同 service から export される
vi.mock('@/services/tenant-storage.service', () => ({
  updateAllStorageBytesUsed: vi.fn(),
  detectDbCapacityDrift: vi.fn(),
}));

// ADR-0021 (2026-05-26): ファイルストレージ集計 + drift
vi.mock('@/services/file-storage-bucket-usage.service', () => ({
  updateAllTenantFileStorageUsage: vi.fn(),
  detectFileStorageDrift: vi.fn(),
}));

import { POST, GET } from './route';
import {
  generateDailyNotifications,
  cleanupReadNotifications,
} from '@/services/notification.service';
import { deleteExpiredPreviews } from '@/services/external-data-import.service';
import {
  updateAllStorageBytesUsed,
  detectDbCapacityDrift,
} from '@/services/tenant-storage.service';
import {
  updateAllTenantFileStorageUsage,
  detectFileStorageDrift,
} from '@/services/file-storage-bucket-usage.service';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(generateDailyNotifications).mockResolvedValue({ startCreated: 0, endCreated: 0 });
  vi.mocked(cleanupReadNotifications).mockResolvedValue({ deleted: 0 });
  vi.mocked(deleteExpiredPreviews).mockResolvedValue(0);
  vi.mocked(updateAllStorageBytesUsed).mockResolvedValue(0);
  vi.mocked(detectDbCapacityDrift).mockResolvedValue({
    tenantPeakSumBytes: BigInt(0),
    dbInstanceSizeBytes: BigInt(0),
    driftRatio: 0,
    driftLevel: 'ok',
  });
  vi.mocked(updateAllTenantFileStorageUsage).mockResolvedValue({
    updatedCount: 0,
    anomalyCount: 0,
    levelChangedCount: 0,
  });
  vi.mocked(detectFileStorageDrift).mockResolvedValue({
    attachmentSumBytes: BigInt(0),
    bucketSumBytes: BigInt(0),
    driftRatio: 0,
    driftLevel: 'ok',
  });
});

function cronReq(authHeader?: string): NextRequest {
  const headers: Record<string, string> = {};
  if (authHeader) headers.authorization = authHeader;
  return new NextRequest('http://localhost/api/cron/daily-notifications', {
    method: 'POST',
    headers,
  });
}

describe('POST /api/cron/daily-notifications', () => {
  it('CRON_SECRET 未設定なら 401 (env 設定漏れの fail-closed)', async () => {
    delete process.env.CRON_SECRET;
    const res = await POST(cronReq('Bearer something'));
    expect(res.status).toBe(401);
  });

  it('Authorization ヘッダなしは 401', async () => {
    process.env.CRON_SECRET = 'test-cron-secret-32chars-or-more-xxxxxxxxxxxxxxxx';
    const res = await POST(cronReq());
    expect(res.status).toBe(401);
  });

  it('Authorization ヘッダが間違っていれば 401', async () => {
    process.env.CRON_SECRET = 'test-cron-secret-32chars-or-more-xxxxxxxxxxxxxxxx';
    const res = await POST(cronReq('Bearer wrong'));
    expect(res.status).toBe(401);
  });

  it('正しい Bearer なら generate + cleanup + 期限切れ preview + storage キャッシュ更新 を実行して 200', async () => {
    process.env.CRON_SECRET = 'test-cron-secret-32chars-or-more-xxxxxxxxxxxxxxxx';
    vi.mocked(generateDailyNotifications).mockResolvedValue({ startCreated: 3, endCreated: 2 });
    vi.mocked(cleanupReadNotifications).mockResolvedValue({ deleted: 5 });
    vi.mocked(deleteExpiredPreviews).mockResolvedValue(2);
    vi.mocked(updateAllStorageBytesUsed).mockResolvedValue(7);

    const res = await POST(cronReq('Bearer test-cron-secret-32chars-or-more-xxxxxxxxxxxxxxxx'));
    expect(res.status).toBe(200);
    const json = await res.json();
    // ADR-0020 (2026-05-25): Grace 判定廃止 + 5 回目検証 R で drift 検知追加
    expect(json.data).toEqual({
      source: 'cron',
      generated: { startCreated: 3, endCreated: 2 },
      cleaned: { deleted: 5 },
      expiredPreviewsDeleted: 2,
      storage: { bytesUpdated: 7, driftRatio: 0, driftLevel: 'ok' },
      fileStorage: {
        tenantsUpdated: 0,
        anomalyCount: 0,
        levelChangedCount: 0,
        driftRatio: 0,
        driftLevel: 'ok',
      },
    });
    expect(generateDailyNotifications).toHaveBeenCalledOnce();
    expect(cleanupReadNotifications).toHaveBeenCalledOnce();
    expect(deleteExpiredPreviews).toHaveBeenCalledOnce();
    expect(updateAllStorageBytesUsed).toHaveBeenCalledOnce();
  });
});

describe('GET /api/cron/daily-notifications', () => {
  it('GET は 405 (POST 限定)', async () => {
    const res = await GET();
    expect(res.status).toBe(405);
  });
});
