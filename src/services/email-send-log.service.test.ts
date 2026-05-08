/**
 * メール送信ログサービスの単体テスト (P-H / 2026-05-08)
 *
 * 検証項目:
 *   - recordEmailSend: PII 漏洩防止 (recipient hash + domain のみ保存)
 *   - isDailyEmailLimitReached: 日次上限到達判定 (今日 0:00 起点)
 *   - getEmailSendStats: 日次/月次集計 + ステータス分類
 *   - DB 書込み失敗時のサイレント無視
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  prisma: {
    emailSendLog: {
      create: vi.fn(),
      count: vi.fn(),
    },
  },
}));

import {
  recordEmailSend,
  isDailyEmailLimitReached,
  getEmailSendStats,
} from './email-send-log.service';
import { prisma } from '@/lib/db';

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.EMAIL_DAILY_LIMIT;
  delete process.env.EMAIL_MONTHLY_LIMIT;
});

afterEach(() => {
  delete process.env.EMAIL_DAILY_LIMIT;
  delete process.env.EMAIL_MONTHLY_LIMIT;
});

describe('recordEmailSend', () => {
  it('recipient を SHA-256 hash 化 + domain だけ平文保存 (PII 漏洩防止)', async () => {
    vi.mocked(prisma.emailSendLog.create).mockResolvedValueOnce({} as never);

    await recordEmailSend({
      type: 'invitation',
      recipientEmail: 'tep***@example.com',
      success: true,
      providerName: 'brevo',
    });

    const callArg = vi.mocked(prisma.emailSendLog.create).mock.calls[0]![0] as {
      data: { recipientHash: string; recipientDomain: string };
    };
    expect(callArg.data.recipientHash).toMatch(/^[a-f0-9]{64}$/); // SHA-256 hex
    expect(callArg.data.recipientDomain).toBe('@example.com');
  });

  it('同じ宛先は同じ hash を生成する (= 同人物への送信回数集計可能)', async () => {
    vi.mocked(prisma.emailSendLog.create).mockResolvedValue({} as never);

    await recordEmailSend({
      type: 'invitation',
      recipientEmail: 'user@example.com',
      success: true,
      providerName: 'brevo',
    });
    await recordEmailSend({
      type: 'invitation',
      recipientEmail: 'USER@example.com', // 大文字
      success: true,
      providerName: 'brevo',
    });

    const calls = vi.mocked(prisma.emailSendLog.create).mock.calls;
    const hash1 = (calls[0]![0] as { data: { recipientHash: string } }).data.recipientHash;
    const hash2 = (calls[1]![0] as { data: { recipientHash: string } }).data.recipientHash;
    expect(hash1).toBe(hash2);
  });

  it('DB 書込み失敗時はサイレントに無視 (= 本体送信を止めない)', async () => {
    vi.mocked(prisma.emailSendLog.create).mockRejectedValueOnce(new Error('db down'));

    // throw されない
    await expect(
      recordEmailSend({
        type: 'invitation',
        recipientEmail: 'user@example.com',
        success: true,
        providerName: 'brevo',
      }),
    ).resolves.toBeUndefined();
  });

  it('tenantId / errorMessage は optional', async () => {
    vi.mocked(prisma.emailSendLog.create).mockResolvedValueOnce({} as never);

    await recordEmailSend({
      type: 'beginner_warning_60',
      recipientEmail: 'billing@customer.example',
      success: false,
      errorMessage: 'mock_error',
      providerName: 'brevo',
      tenantId: 'tenant-uuid-1',
    });

    const callArg = vi.mocked(prisma.emailSendLog.create).mock.calls[0]![0] as {
      data: { tenantId: string; errorMessage: string };
    };
    expect(callArg.data.tenantId).toBe('tenant-uuid-1');
    expect(callArg.data.errorMessage).toBe('mock_error');
  });
});

describe('isDailyEmailLimitReached', () => {
  it('当日件数 < 上限なら false', async () => {
    vi.mocked(prisma.emailSendLog.count).mockResolvedValueOnce(150);

    expect(await isDailyEmailLimitReached()).toBe(false);
  });

  it('当日件数 = 上限なら true (境界)', async () => {
    vi.mocked(prisma.emailSendLog.count).mockResolvedValueOnce(300); // = default

    expect(await isDailyEmailLimitReached()).toBe(true);
  });

  it('当日件数 > 上限なら true', async () => {
    vi.mocked(prisma.emailSendLog.count).mockResolvedValueOnce(500);

    expect(await isDailyEmailLimitReached()).toBe(true);
  });

  it('env で上限を上書きできる', async () => {
    process.env.EMAIL_DAILY_LIMIT = '1000';
    vi.mocked(prisma.emailSendLog.count).mockResolvedValueOnce(800);

    expect(await isDailyEmailLimitReached()).toBe(false);
  });
});

describe('getEmailSendStats', () => {
  function setupCounts(daily: number, dailySuccess: number, dailyFailed: number, monthly: number) {
    vi.mocked(prisma.emailSendLog.count)
      .mockResolvedValueOnce(daily) // dailyTotal
      .mockResolvedValueOnce(dailySuccess) // dailySuccessful
      .mockResolvedValueOnce(dailyFailed) // dailyFailed
      .mockResolvedValueOnce(monthly); // monthlyTotal
  }

  it('正常系: 集計値 + ステータス分類を返す', async () => {
    setupCounts(150, 145, 5, 2000);
    const NOW = new Date('2026-05-08T12:00:00Z');

    const stats = await getEmailSendStats(NOW);

    expect(stats.dailySent).toBe(150);
    expect(stats.dailySuccessful).toBe(145);
    expect(stats.dailyFailed).toBe(5);
    expect(stats.monthlySent).toBe(2000);
    expect(stats.dailyLimit).toBe(300);
    expect(stats.monthlyLimit).toBeNull();
    expect(stats.dailyStatus).toBe('ok'); // 150/300 = 50%
    expect(stats.dailyUtilizationRatio).toBe(0.5);
    expect(stats.monthlyUtilizationRatio).toBeNull();
  });

  it('日次 80% で warn', async () => {
    setupCounts(240, 240, 0, 1000);
    const stats = await getEmailSendStats();
    expect(stats.dailyStatus).toBe('warn');
  });

  it('日次 90% で alert', async () => {
    setupCounts(270, 270, 0, 1000);
    const stats = await getEmailSendStats();
    expect(stats.dailyStatus).toBe('alert');
  });

  it('env で月次上限を指定すると monthlyStatus が計算される', async () => {
    process.env.EMAIL_MONTHLY_LIMIT = '3000';
    setupCounts(100, 100, 0, 2700); // 月次 90%
    const stats = await getEmailSendStats();
    expect(stats.monthlyLimit).toBe(3000);
    expect(stats.monthlyStatus).toBe('alert');
    expect(stats.monthlyUtilizationRatio).toBeCloseTo(0.9);
  });

  it('measuredAt は引数の now を使う', async () => {
    setupCounts(0, 0, 0, 0);
    const NOW = new Date('2026-05-08T12:00:00Z');
    const stats = await getEmailSendStats(NOW);
    expect(stats.measuredAt).toEqual(NOW);
  });

  it('count は今日 0:00 UTC 起点で実行される', async () => {
    setupCounts(0, 0, 0, 0);
    const NOW = new Date('2026-05-08T15:30:00Z'); // 当日 15:30 UTC
    await getEmailSendStats(NOW);

    const dailyCallArg = vi.mocked(prisma.emailSendLog.count).mock.calls[0]![0] as {
      where: { sentAt: { gte: Date } };
    };
    expect(dailyCallArg.where.sentAt.gte.toISOString()).toBe('2026-05-08T00:00:00.000Z');
  });

  it('月次 count は当月 1 日 0:00 UTC 起点', async () => {
    setupCounts(0, 0, 0, 0);
    const NOW = new Date('2026-05-08T15:30:00Z');
    await getEmailSendStats(NOW);

    const monthlyCallArg = vi.mocked(prisma.emailSendLog.count).mock.calls[3]![0] as {
      where: { sentAt: { gte: Date } };
    };
    expect(monthlyCallArg.where.sentAt.gte.toISOString()).toBe('2026-05-01T00:00:00.000Z');
  });
});
