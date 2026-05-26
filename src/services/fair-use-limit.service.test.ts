/**
 * fair-use-limit.service.ts のユニットテスト (ADR-0019 / 2026-05-24)
 *
 * テスト方針:
 *   - billable / 無料両方の featureUnit のカウント挙動を固定
 *   - WARNING (8,000) / HARD (10,000) 閾値の境界値テスト
 *   - tenant TZ 月境界が getTenantMonthStart 経由で正しく渡されることを確認
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  prisma: {
    apiCallLog: {
      count: vi.fn(),
    },
    tenant: {
      findMany: vi.fn(),
    },
  },
}));

import {
  checkFairUseLimit,
  FAIR_USE_LIMIT,
  listFairUseUsage,
} from './fair-use-limit.service';
import { prisma } from '@/lib/db';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('FAIR_USE_LIMIT 定数', () => {
  it('ADR-0019 で確定した閾値 (warning 8,000 / hard 10,000) を持つ', () => {
    expect(FAIR_USE_LIMIT.WARNING).toBe(8_000);
    expect(FAIR_USE_LIMIT.HARD).toBe(10_000);
  });

  it('warning < hard の関係を保つ', () => {
    expect(FAIR_USE_LIMIT.WARNING).toBeLessThan(FAIR_USE_LIMIT.HARD);
  });
});

describe('checkFairUseLimit - 境界値', () => {
  it('count=0 (利用なし) は allowed=true, warningExceeded=false', async () => {
    vi.mocked(prisma.apiCallLog.count).mockResolvedValue(0);

    const result = await checkFairUseLimit(TENANT_ID, 'Asia/Tokyo');

    expect(result.allowed).toBe(true);
    if (result.allowed) {
      expect(result.usedCount).toBe(0);
      expect(result.warningExceeded).toBe(false);
    }
  });

  it('count=7,999 (warning 直前) は allowed=true, warningExceeded=false', async () => {
    vi.mocked(prisma.apiCallLog.count).mockResolvedValue(7_999);

    const result = await checkFairUseLimit(TENANT_ID, 'Asia/Tokyo');

    expect(result.allowed).toBe(true);
    if (result.allowed) {
      expect(result.warningExceeded).toBe(false);
    }
  });

  it('count=8,000 (warning 到達ちょうど) は allowed=true, warningExceeded=true', async () => {
    vi.mocked(prisma.apiCallLog.count).mockResolvedValue(8_000);

    const result = await checkFairUseLimit(TENANT_ID, 'Asia/Tokyo');

    expect(result.allowed).toBe(true);
    if (result.allowed) {
      expect(result.warningExceeded).toBe(true);
    }
  });

  it('count=9,999 (hard 直前) は allowed=true, warningExceeded=true', async () => {
    vi.mocked(prisma.apiCallLog.count).mockResolvedValue(9_999);

    const result = await checkFairUseLimit(TENANT_ID, 'Asia/Tokyo');

    expect(result.allowed).toBe(true);
    if (result.allowed) {
      expect(result.warningExceeded).toBe(true);
    }
  });

  it('count=10,000 (hard 到達ちょうど) は allowed=false, fair_use_limit_exceeded', async () => {
    vi.mocked(prisma.apiCallLog.count).mockResolvedValue(10_000);

    const result = await checkFairUseLimit(TENANT_ID, 'Asia/Tokyo');

    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toBe('fair_use_limit_exceeded');
      expect(result.usedCount).toBe(10_000);
      expect(result.hardLimit).toBe(10_000);
      expect(result.message).toContain('10,000');
    }
  });

  it('count=100,000 (大幅超過) も同様に縮退モード', async () => {
    vi.mocked(prisma.apiCallLog.count).mockResolvedValue(100_000);

    const result = await checkFairUseLimit(TENANT_ID, 'Asia/Tokyo');

    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.usedCount).toBe(100_000);
    }
  });
});

describe('checkFairUseLimit - 集計対象', () => {
  it('課金対象 featureUnit (BILLABLE_FEATURE_UNITS) を集計から除外する', async () => {
    vi.mocked(prisma.apiCallLog.count).mockResolvedValue(0);

    await checkFairUseLimit(TENANT_ID, 'Asia/Tokyo');

    const callArg = vi.mocked(prisma.apiCallLog.count).mock.calls[0]?.[0];
    // ADR-0019: project-upsert / suggestion-explanation / auto-tag-extract
    // ADR-0020 (2026-05-25): + db-capacity-overage
    // ADR-0021 (2026-05-26): + storage-file-overage
    expect(callArg?.where?.featureUnit).toEqual({
      notIn: [
        'project-upsert',
        'suggestion-explanation',
        'auto-tag-extract',
        'db-capacity-overage',
        'storage-file-overage',
      ],
    });
  });

  it('tenantId フィルタが付与される (テナント越境防止)', async () => {
    vi.mocked(prisma.apiCallLog.count).mockResolvedValue(0);

    await checkFairUseLimit(TENANT_ID, 'Asia/Tokyo');

    const callArg = vi.mocked(prisma.apiCallLog.count).mock.calls[0]?.[0];
    expect(callArg?.where?.tenantId).toBe(TENANT_ID);
  });

  it('createdAt は月初以降の範囲 (= テナント TZ ベース)', async () => {
    vi.mocked(prisma.apiCallLog.count).mockResolvedValue(0);

    // 2026-05-24 15:00 JST 時点での集計
    const now = new Date('2026-05-24T06:00:00Z'); // = 2026-05-24 15:00 JST
    await checkFairUseLimit(TENANT_ID, 'Asia/Tokyo', now);

    const callArg = vi.mocked(prisma.apiCallLog.count).mock.calls[0]?.[0];
    expect(callArg?.where?.createdAt).toHaveProperty('gte');
    // JST 5/1 00:00 = UTC 4/30 15:00
    const gte = (callArg?.where?.createdAt as { gte: Date }).gte;
    expect(gte.toISOString()).toBe('2026-04-30T15:00:00.000Z');
  });

  it('timezone=null なら DEFAULT_TIMEZONE (Asia/Tokyo) を使う', async () => {
    vi.mocked(prisma.apiCallLog.count).mockResolvedValue(0);

    const now = new Date('2026-05-24T06:00:00Z');
    await checkFairUseLimit(TENANT_ID, null, now);

    const callArg = vi.mocked(prisma.apiCallLog.count).mock.calls[0]?.[0];
    const gte = (callArg?.where?.createdAt as { gte: Date }).gte;
    // Asia/Tokyo (UTC+9) の 2026-05-01 00:00 = 2026-04-30T15:00:00Z
    expect(gte.toISOString()).toBe('2026-04-30T15:00:00.000Z');
  });
});

describe('listFairUseUsage', () => {
  it('全テナントの fair use 状態を集計し、status 別に分類する', async () => {
    vi.mocked(prisma.tenant.findMany).mockResolvedValue([
      { id: 't1', name: 'OK Tenant', timezone: 'Asia/Tokyo' },
      { id: 't2', name: 'Warning Tenant', timezone: 'Asia/Tokyo' },
      { id: 't3', name: 'Hard Tenant', timezone: 'Asia/Tokyo' },
    ] as never);
    vi.mocked(prisma.apiCallLog.count)
      .mockResolvedValueOnce(100) // t1: ok
      .mockResolvedValueOnce(8_500) // t2: warning
      .mockResolvedValueOnce(10_000); // t3: hard

    const results = await listFairUseUsage();

    expect(results).toHaveLength(3);
    expect(results.find((r) => r.tenantId === 't1')?.status).toBe('ok');
    expect(results.find((r) => r.tenantId === 't2')?.status).toBe('warning');
    expect(results.find((r) => r.tenantId === 't3')?.status).toBe('hard');
  });

  it('deletedAt=null フィルタでテナントを取得 (削除済除外)', async () => {
    vi.mocked(prisma.tenant.findMany).mockResolvedValue([] as never);

    await listFairUseUsage();

    const callArg = vi.mocked(prisma.tenant.findMany).mock.calls[0]?.[0];
    expect(callArg?.where).toEqual({ deletedAt: null });
  });
});
