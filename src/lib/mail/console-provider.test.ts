import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  prisma: {
    systemErrorLog: { create: vi.fn() },
  },
}));

import { ConsoleMailProvider } from './console-provider';
import { prisma } from '@/lib/db';

describe('ConsoleMailProvider (PR #115: DB 記録に移行)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.systemErrorLog.create).mockResolvedValue({} as never);
  });

  it('send は常に success: true を返し、messageId を含む', async () => {
    const provider = new ConsoleMailProvider();

    const result = await provider.send({
      to: 'alice@example.com',
      subject: 'Hello',
      html: '<p>test</p>',
    });

    expect(result.success).toBe(true);
    expect(result.messageId).toMatch(/^console-\d+$/);
    // PR #115: console ではなく systemErrorLog に保存される
    expect(prisma.systemErrorLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          severity: 'info',
          source: 'mail',
          message: expect.stringContaining('ConsoleMailProvider'),
        }),
      }),
    );
  });

  it('長い HTML は 200 文字で切り詰めて DB に保存する', async () => {
    const provider = new ConsoleMailProvider();
    const longHtml = 'x'.repeat(500);

    await provider.send({ to: 'a@b.co', subject: 's', html: longHtml });

    const call = vi.mocked(prisma.systemErrorLog.create).mock.calls[0][0];
    const context = (call.data as { context: { htmlPreview: string } }).context;
    expect(context.htmlPreview.length).toBeLessThanOrEqual(200);
    expect(context.htmlPreview).not.toContain('x'.repeat(500));
  });
});
