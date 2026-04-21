import { describe, it, expect, vi } from 'vitest';
import { ConsoleMailProvider } from './console-provider';

describe('ConsoleMailProvider', () => {
  it('send は常に success: true を返し、messageId を含む', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const provider = new ConsoleMailProvider();

    const result = await provider.send({
      to: 'alice@example.com',
      subject: 'Hello',
      html: '<p>test</p>',
    });

    expect(result.success).toBe(true);
    expect(result.messageId).toMatch(/^console-\d+$/);
    expect(spy).toHaveBeenCalled();

    spy.mockRestore();
  });

  it('長い HTML は 200 文字で切り詰めて出力する', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const provider = new ConsoleMailProvider();
    const longHtml = 'x'.repeat(500);

    await provider.send({ to: 'a@b.co', subject: 's', html: longHtml });

    const logs = spy.mock.calls.map((c) => c.join(' ')).join('\n');
    // 500 文字全部は出力されない (200 文字 + ...)
    expect(logs).not.toContain('x'.repeat(500));
    expect(logs).toContain('...');

    spy.mockRestore();
  });
});
