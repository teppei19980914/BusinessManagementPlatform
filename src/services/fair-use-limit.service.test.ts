/**
 * fair-use-limit.service.ts のユニットテスト (ADR-0019 / 2026-05-24 → ADR-0022 で Beginner 専用に縮小 / 2026-06-01)
 *
 * テスト方針 (ADR-0022 後):
 *   - 集計対象は EMBEDDING_BILLABLE_FEATURE_UNITS の SUM (= Beginner プラン × ユーザ起動 Embedding)
 *   - WARNING (8,000) / HARD (10,000) 閾値の境界値テスト
 *   - tenant TZ 月境界が getTenantMonthStart 経由で正しく渡されることを確認
 *   - listFairUseUsage は plan='beginner' のテナントのみを対象とする
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
  it('EMBEDDING_BILLABLE_FEATURE_UNITS のみを集計対象とする (ADR-0022)', async () => {
    vi.mocked(prisma.apiCallLog.count).mockResolvedValue(0);

    await checkFairUseLimit(TENANT_ID, 'Asia/Tokyo');

    const callArg = vi.mocked(prisma.apiCallLog.count).mock.calls[0]?.[0];
    // ADR-0022 (2026-06-01): Beginner プランのユーザ起動 Embedding (= Voyage 無料枠を消費する操作) のみを対象。
    //   LLM_BILLABLE は Beginner 50 件 / budget cap で別防御、Backfill は ユーザ非起動で対象外、
    //   Storage Overage は本パスを通らない (= 月初 cron 直接 INSERT)。
    expect(callArg?.where?.featureUnit).toEqual({
      in: [
        'knowledge-embedding',
        'risk-issue-embedding',
        'retrospective-embedding',
        'memo-embedding',
        'chat-semantic-search',
        'external-import-embedding',
        'attachment-embedding',
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

  it('deletedAt=null かつ plan=beginner フィルタでテナントを取得 (ADR-0022 で Beginner 限定に縮小)', async () => {
    vi.mocked(prisma.tenant.findMany).mockResolvedValue([] as never);

    await listFairUseUsage();

    const callArg = vi.mocked(prisma.tenant.findMany).mock.calls[0]?.[0];
    // ADR-0022 (2026-06-01): Expert/Pro は monthlyBudgetCap で自然防御されるため Fair Use Limit
    //   の対象外。Beginner プランのみを監視。
    expect(callArg?.where).toEqual({ deletedAt: null, plan: 'beginner' });
  });
});
