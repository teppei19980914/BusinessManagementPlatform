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
vi.mock('@/services/tenant-storage.service', () => ({
  updateAllStorageBytesUsed: vi.fn(),
}));

import { POST, GET } from './route';
import {
  generateDailyNotifications,
  cleanupReadNotifications,
} from '@/services/notification.service';
import { deleteExpiredPreviews } from '@/services/external-data-import.service';
import { updateAllStorageBytesUsed } from '@/services/tenant-storage.service';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(generateDailyNotifications).mockResolvedValue({ startCreated: 0, endCreated: 0 });
  vi.mocked(cleanupReadNotifications).mockResolvedValue({ deleted: 0 });
  vi.mocked(deleteExpiredPreviews).mockResolvedValue(0);
  vi.mocked(updateAllStorageBytesUsed).mockResolvedValue(0);
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
    // ADR-0020 (2026-05-25): Grace 判定廃止のため storage は bytesUpdated のみ
    expect(json.data).toEqual({
      source: 'cron',
      generated: { startCreated: 3, endCreated: 2 },
      cleaned: { deleted: 5 },
      expiredPreviewsDeleted: 2,
      storage: { bytesUpdated: 7 },
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
