/**
 * cron 実行履歴ロギング共通ヘルパの単体テスト (PR feat/cron-execution-log / 2026-05-18)
 *
 * 検証観点:
 *   1. 成功時: status='running' で create → status='success' に update + durationMs / payloadJson 記録
 *   2. 失敗時: status='failure' + errorMessage / errorStack 記録 + 500 レスポンス
 *   3. log create 失敗時でも cron 本体は走る (= fail-soft)
 *   4. log update 失敗時でも cron 結果は返る (= fail-soft)
 *   5. invokerIp 抽出: x-forwarded-for の先頭値、欠落時は null
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

vi.mock('@/lib/db', () => ({
  prisma: {
    cronExecutionLog: {
      create: vi.fn(),
      update: vi.fn(),
    },
  },
}));

import { prisma } from '@/lib/db';
import { withCronExecutionLogging } from './cron-execution-log';

function makeReq(xff: string | null): NextRequest {
  return {
    headers: {
      get: (name: string) => (name.toLowerCase() === 'x-forwarded-for' ? xff : null),
    },
  } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.cronExecutionLog.create).mockResolvedValue({ id: 'log-1' } as never);
  vi.mocked(prisma.cronExecutionLog.update).mockResolvedValue({} as never);
});

describe('withCronExecutionLogging', () => {
  it('成功時: running → success に update + payloadJson 記録 + 200', async () => {
    const handler = vi.fn().mockResolvedValue({ data: { source: 'cron', processed: 3 } });
    const res = await withCronExecutionLogging('test-cron', makeReq(null), handler);

    expect(handler).toHaveBeenCalled();
    expect(prisma.cronExecutionLog.create).toHaveBeenCalledWith({
      data: { cronName: 'test-cron', status: 'running', invokerIp: null },
      select: { id: true },
    });
    expect(prisma.cronExecutionLog.update).toHaveBeenCalledWith({
      where: { id: 'log-1' },
      data: expect.objectContaining({
        status: 'success',
        payloadJson: { source: 'cron', processed: 3 },
        errorMessage: undefined,
        errorStack: null,
      }),
    });
    expect(res.status).toBe(200);
  });

  it('失敗時: running → failure に update + errorMessage 記録 + 500', async () => {
    const handler = vi.fn().mockRejectedValue(new Error('DB connection lost'));
    const res = await withCronExecutionLogging('test-cron', makeReq(null), handler);

    expect(prisma.cronExecutionLog.update).toHaveBeenCalledWith({
      where: { id: 'log-1' },
      data: expect.objectContaining({
        status: 'failure',
        errorMessage: 'DB connection lost',
        errorStack: expect.any(String),
      }),
    });
    expect(res.status).toBe(500);
  });

  it('log create 失敗時でも cron 本体は走り 200 を返す (fail-soft)', async () => {
    vi.mocked(prisma.cronExecutionLog.create).mockRejectedValueOnce(new Error('DB down'));
    const handler = vi.fn().mockResolvedValue({ data: { source: 'cron' } });

    const res = await withCronExecutionLogging('test-cron', makeReq(null), handler);

    expect(handler).toHaveBeenCalled();
    expect(res.status).toBe(200);
    // logId=null なので update は呼ばれない
    expect(prisma.cronExecutionLog.update).not.toHaveBeenCalled();
  });

  it('log update 失敗時でも cron 結果は返る (fail-soft)', async () => {
    vi.mocked(prisma.cronExecutionLog.update).mockRejectedValueOnce(new Error('DB hiccup'));
    const handler = vi.fn().mockResolvedValue({ data: { source: 'cron' } });

    const res = await withCronExecutionLogging('test-cron', makeReq(null), handler);

    expect(res.status).toBe(200);
  });

  it('invokerIp: x-forwarded-for の先頭値を採用', async () => {
    const handler = vi.fn().mockResolvedValue({ data: {} });
    await withCronExecutionLogging('test-cron', makeReq('192.0.2.1, 198.51.100.42'), handler);

    expect(prisma.cronExecutionLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ invokerIp: '192.0.2.1' }),
      }),
    );
  });

  it('invokerIp: 45 文字を超える場合は切詰める', async () => {
    const handler = vi.fn().mockResolvedValue({ data: {} });
    const longIp = 'a'.repeat(100);
    await withCronExecutionLogging('test-cron', makeReq(longIp), handler);

    const createCall = vi.mocked(prisma.cronExecutionLog.create).mock.calls[0]?.[0];
    expect((createCall?.data as { invokerIp: string }).invokerIp).toHaveLength(45);
  });
});
