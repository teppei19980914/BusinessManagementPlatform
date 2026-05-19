/**
 * cron-health.service の単体テスト (PR-V8 / 2026-05-19)
 *
 * 検証項目:
 *   - checkCronHealth:
 *     - 最後の成功が ギャップ内 → status='healthy', isUnhealthy=false
 *     - 最後の成功が ギャップ超過 → status='stale', isUnhealthy=true ★本件 regression
 *     - 記録ゼロ → status='never_recorded', isUnhealthy=true ★本件 regression
 *     - CRON_JOBS 未登録の cron 名 → null
 *   - checkAllCronHealth:
 *     - 全 cron をチェック
 *     - 異常を先頭、経過時間が長い順にソート
 *   - listUnhealthyCrons: stale + never_recorded のみ返す
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  prisma: {
    cronExecutionLog: {
      findFirst: vi.fn(),
    },
  },
}));

import {
  checkCronHealth,
  checkAllCronHealth,
  listUnhealthyCrons,
} from './cron-health.service';
import { prisma } from '@/lib/db';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('checkCronHealth', () => {
  it('CRON_JOBS 未登録 → null (DB 問合せもしない)', async () => {
    const result = await checkCronHealth('non-existent-cron');
    expect(result).toBeNull();
    expect(prisma.cronExecutionLog.findFirst).not.toHaveBeenCalled();
  });

  it('daily cron (expectedMaxGapHours=25) で 12h 前に成功 → healthy', async () => {
    const now = new Date('2026-05-19T12:00:00Z');
    vi.mocked(prisma.cronExecutionLog.findFirst)
      .mockResolvedValueOnce({ startedAt: new Date('2026-05-19T00:00:00Z') } as never) // last success 12h 前
      .mockResolvedValueOnce(null as never); // last failure なし

    const result = await checkCronHealth('daily-notifications', now);
    expect(result?.status).toBe('healthy');
    expect(result?.isUnhealthy).toBe(false);
    expect(result?.hoursSinceLastSuccess).toBeCloseTo(12, 1);
  });

  // ★ PR-V8: 本件 regression。daily cron が 26h 動いていない (= cron-job.org 障害等)
  it('★本件 regression★ daily cron が 26h 前 (= 25h 超過) → stale, isUnhealthy=true', async () => {
    const now = new Date('2026-05-19T12:00:00Z');
    vi.mocked(prisma.cronExecutionLog.findFirst)
      .mockResolvedValueOnce({ startedAt: new Date('2026-05-18T10:00:00Z') } as never) // 26h 前
      .mockResolvedValueOnce(null as never);

    const result = await checkCronHealth('daily-notifications', now);
    expect(result?.status).toBe('stale');
    expect(result?.isUnhealthy).toBe(true);
    expect(result?.hoursSinceLastSuccess).toBeCloseTo(26, 1);
  });

  // ★ PR-V8: 本件 regression。tenant-monthly-reset が cron-job.org 未登録で 1 度も走っていない
  it('★本件 regression★ tenant-monthly-reset 記録ゼロ → never_recorded, isUnhealthy=true', async () => {
    const now = new Date('2026-05-19T12:00:00Z');
    vi.mocked(prisma.cronExecutionLog.findFirst)
      .mockResolvedValueOnce(null as never) // last success なし
      .mockResolvedValueOnce(null as never);

    const result = await checkCronHealth('tenant-monthly-reset', now);
    expect(result?.status).toBe('never_recorded');
    expect(result?.isUnhealthy).toBe(true);
    expect(result?.hoursSinceLastSuccess).toBeNull();
    expect(result?.lastSuccessAt).toBeNull();
  });

  it('monthly cron (expectedMaxGapHours=840) で 30 日前に成功 → healthy', async () => {
    const now = new Date('2026-05-19T12:00:00Z');
    const thirtyDaysAgo = new Date('2026-04-19T12:00:00Z');
    vi.mocked(prisma.cronExecutionLog.findFirst)
      .mockResolvedValueOnce({ startedAt: thirtyDaysAgo } as never) // 30日 = 720h
      .mockResolvedValueOnce(null as never);

    const result = await checkCronHealth('tenant-monthly-reset', now);
    expect(result?.status).toBe('healthy');
    expect(result?.hoursSinceLastSuccess).toBeCloseTo(720, 0);
  });

  it('monthly cron で 36 日前に成功 (= 840h 超過) → stale', async () => {
    const now = new Date('2026-05-19T12:00:00Z');
    const thirtySixDaysAgo = new Date('2026-04-13T12:00:00Z');
    vi.mocked(prisma.cronExecutionLog.findFirst)
      .mockResolvedValueOnce({ startedAt: thirtySixDaysAgo } as never) // 36日 = 864h
      .mockResolvedValueOnce(null as never);

    const result = await checkCronHealth('tenant-monthly-reset', now);
    expect(result?.status).toBe('stale');
  });

  it('最後の失敗時刻も取得して返す', async () => {
    const now = new Date('2026-05-19T12:00:00Z');
    vi.mocked(prisma.cronExecutionLog.findFirst)
      .mockResolvedValueOnce({ startedAt: new Date('2026-05-19T00:00:00Z') } as never)
      .mockResolvedValueOnce({ startedAt: new Date('2026-05-18T22:00:00Z') } as never);

    const result = await checkCronHealth('daily-notifications', now);
    expect(result?.lastSuccessAt?.toISOString()).toBe('2026-05-19T00:00:00.000Z');
    expect(result?.lastFailureAt?.toISOString()).toBe('2026-05-18T22:00:00.000Z');
  });
});

describe('checkAllCronHealth', () => {
  it('全 cron をチェックして配列で返す', async () => {
    const now = new Date('2026-05-19T12:00:00Z');
    // 全 cron に対して find が呼ばれる (success + failure で 2 回ずつ)
    vi.mocked(prisma.cronExecutionLog.findFirst).mockResolvedValue({
      startedAt: new Date('2026-05-19T00:00:00Z'),
    } as never);

    const results = await checkAllCronHealth(now);
    // CRON_JOBS に登録されている全 cron 分の結果が返る
    expect(results.length).toBeGreaterThan(0);
    // 全部 healthy
    for (const r of results) {
      expect(r.status).toBe('healthy');
    }
  });

  it('異常 cron を先頭にソート', async () => {
    const now = new Date('2026-05-19T12:00:00Z');
    // tenant-monthly-reset だけ never_recorded、その他は healthy
    vi.mocked(prisma.cronExecutionLog.findFirst).mockImplementation((arg) => {
      const cronName = (arg as { where: { cronName: string } }).where.cronName;
      if (cronName === 'tenant-monthly-reset') {
        return Promise.resolve(null) as never;
      }
      return Promise.resolve({ startedAt: new Date('2026-05-19T00:00:00Z') }) as never;
    });

    const results = await checkAllCronHealth(now);
    // 先頭が tenant-monthly-reset (= never_recorded)
    expect(results[0].cronName).toBe('tenant-monthly-reset');
    expect(results[0].isUnhealthy).toBe(true);
  });
});

describe('listUnhealthyCrons', () => {
  it('healthy は除外し、stale + never_recorded のみ返す', async () => {
    const now = new Date('2026-05-19T12:00:00Z');
    vi.mocked(prisma.cronExecutionLog.findFirst).mockImplementation((arg) => {
      const cronName = (arg as { where: { cronName: string } }).where.cronName;
      if (cronName === 'tenant-monthly-reset') {
        return Promise.resolve(null) as never;
      }
      return Promise.resolve({ startedAt: new Date('2026-05-19T00:00:00Z') }) as never;
    });

    const unhealthy = await listUnhealthyCrons(now);
    expect(unhealthy).toHaveLength(1);
    expect(unhealthy[0].cronName).toBe('tenant-monthly-reset');
    expect(unhealthy[0].status).toBe('never_recorded');
  });

  it('全て healthy なら空配列', async () => {
    const now = new Date('2026-05-19T12:00:00Z');
    vi.mocked(prisma.cronExecutionLog.findFirst).mockResolvedValue({
      startedAt: new Date('2026-05-19T00:00:00Z'),
    } as never);

    const unhealthy = await listUnhealthyCrons(now);
    expect(unhealthy).toHaveLength(0);
  });
});
