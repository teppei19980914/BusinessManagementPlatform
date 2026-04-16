import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMailProvider } from './index';
import { ConsoleMailProvider } from './console-provider';
import { ResendMailProvider } from './resend-provider';
import { BrevoMailProvider } from './brevo-provider';

describe('createMailProvider', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // リセット
    delete process.env.MAIL_PROVIDER;
    delete process.env.BREVO_API_KEY;
    delete process.env.RESEND_API_KEY;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('MAIL_PROVIDER 未設定時は ConsoleMailProvider を返す', () => {
    const provider = createMailProvider();
    expect(provider).toBeInstanceOf(ConsoleMailProvider);
  });

  it('MAIL_PROVIDER=console で ConsoleMailProvider を返す', () => {
    process.env.MAIL_PROVIDER = 'console';
    const provider = createMailProvider();
    expect(provider).toBeInstanceOf(ConsoleMailProvider);
  });

  it('MAIL_PROVIDER=brevo + BREVO_API_KEY 設定済みで BrevoMailProvider を返す', () => {
    process.env.MAIL_PROVIDER = 'brevo';
    process.env.BREVO_API_KEY = 'test-key';
    const provider = createMailProvider();
    expect(provider).toBeInstanceOf(BrevoMailProvider);
  });

  it('MAIL_PROVIDER=brevo + BREVO_API_KEY 未設定で ConsoleMailProvider にフォールバック', () => {
    process.env.MAIL_PROVIDER = 'brevo';
    const provider = createMailProvider();
    expect(provider).toBeInstanceOf(ConsoleMailProvider);
  });

  it('MAIL_PROVIDER=resend + RESEND_API_KEY 設定済みで ResendMailProvider を返す', () => {
    process.env.MAIL_PROVIDER = 'resend';
    process.env.RESEND_API_KEY = 'test-key';
    const provider = createMailProvider();
    expect(provider).toBeInstanceOf(ResendMailProvider);
  });

  it('MAIL_PROVIDER=resend + RESEND_API_KEY 未設定で ConsoleMailProvider にフォールバック', () => {
    process.env.MAIL_PROVIDER = 'resend';
    const provider = createMailProvider();
    expect(provider).toBeInstanceOf(ConsoleMailProvider);
  });
});
