import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BrevoMailProvider } from './brevo-provider';

describe('BrevoMailProvider', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.BREVO_API_KEY = 'test-api-key';
    process.env.MAIL_FROM = 'noreply@example.com';
    process.env.MAIL_FROM_NAME = 'テスト';
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('API キー未設定時は success: false を返す', async () => {
    process.env.BREVO_API_KEY = '';
    const provider = new BrevoMailProvider();
    const result = await provider.send({
      to: 'test@example.com',
      subject: 'テスト',
      html: '<p>テスト</p>',
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('BREVO_API_KEY');
  });

  it('送信成功時は success: true と messageId を返す', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ messageId: '<msg-123>' }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const provider = new BrevoMailProvider();
    const result = await provider.send({
      to: 'user@example.com',
      subject: 'テスト件名',
      html: '<p>本文</p>',
      text: 'テキスト本文',
    });

    expect(result.success).toBe(true);
    expect(result.messageId).toBe('<msg-123>');

    // Brevo API のリクエスト形式を検証
    expect(mockFetch).toHaveBeenCalledWith('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': 'test-api-key',
      },
      body: JSON.stringify({
        sender: { name: 'テスト', email: 'noreply@example.com' },
        to: [{ email: 'user@example.com' }],
        subject: 'テスト件名',
        htmlContent: '<p>本文</p>',
        textContent: 'テキスト本文',
      }),
    });
  });

  it('API エラー時は success: false とエラーメッセージを返す', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: () => Promise.resolve('{"code":"invalid_parameter","message":"Invalid email"}'),
    });
    vi.stubGlobal('fetch', mockFetch);

    const provider = new BrevoMailProvider();
    const result = await provider.send({
      to: 'invalid',
      subject: 'テスト',
      html: '<p>テスト</p>',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('invalid_parameter');
  });

  it('ネットワークエラー時は success: false を返す', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('Network error'));
    vi.stubGlobal('fetch', mockFetch);

    const provider = new BrevoMailProvider();
    const result = await provider.send({
      to: 'test@example.com',
      subject: 'テスト',
      html: '<p>テスト</p>',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Network error');
  });

  it('text パラメータが未指定の場合は textContent を送信しない', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ messageId: '<msg-456>' }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const provider = new BrevoMailProvider();
    await provider.send({
      to: 'test@example.com',
      subject: 'テスト',
      html: '<p>HTML のみ</p>',
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.textContent).toBeUndefined();
  });
});
