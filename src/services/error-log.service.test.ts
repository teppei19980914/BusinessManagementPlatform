import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  prisma: {
    systemErrorLog: { create: vi.fn() },
  },
}));

import { recordError, logUnknownError } from './error-log.service';
import { prisma } from '@/lib/db';

describe('recordError', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.systemErrorLog.create).mockResolvedValue({} as never);
  });

  it('必須項目のみで書き込める (severity は既定 error)', async () => {
    await recordError({ source: 'server', message: 'boom' });

    expect(prisma.systemErrorLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        severity: 'error',
        source: 'server',
        message: 'boom',
      }),
    });
  });

  it('severity を明示指定できる (info/warn/error/fatal)', async () => {
    await recordError({ severity: 'warn', source: 'mail', message: 'config missing' });

    const call = vi.mocked(prisma.systemErrorLog.create).mock.calls[0][0];
    expect(call.data.severity).toBe('warn');
  });

  it('userId / requestId / context を付与して保存できる', async () => {
    await recordError({
      source: 'server',
      message: 'oops',
      userId: 'u-1',
      requestId: 'req-abc',
      context: { path: '/api/foo', method: 'POST' },
    });

    expect(prisma.systemErrorLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'u-1',
        requestId: 'req-abc',
        context: expect.objectContaining({ path: '/api/foo' }),
      }),
    });
  });

  it('DB 書込失敗は silent (例外を呼出元に伝えない / 再帰ログを防ぐ)', async () => {
    vi.mocked(prisma.systemErrorLog.create).mockRejectedValue(new Error('DB down'));

    // Should not throw
    await expect(
      recordError({ source: 'server', message: 'x' }),
    ).resolves.toBeUndefined();
  });
});

describe('logUnknownError', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.systemErrorLog.create).mockResolvedValue({} as never);
  });

  it('Error インスタンスは message + stack を抽出して保存', async () => {
    const err = new Error('something went wrong');
    await logUnknownError('server', err, { userId: 'u-1' });

    const call = vi.mocked(prisma.systemErrorLog.create).mock.calls[0][0];
    expect(call.data.message).toBe('something went wrong');
    expect(call.data.stack).toBeTruthy();
    expect(call.data.userId).toBe('u-1');
  });

  it('非 Error は String() で message に変換', async () => {
    await logUnknownError('server', 'raw string error');

    const call = vi.mocked(prisma.systemErrorLog.create).mock.calls[0][0];
    expect(call.data.message).toBe('raw string error');
    expect(call.data.stack).toBeUndefined();
  });
});
