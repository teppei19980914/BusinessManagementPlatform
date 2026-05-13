import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createMailProvider } from './index';
import { ConsoleMailProvider } from './console-provider';
import { ResendMailProvider } from './resend-provider';
import { BrevoMailProvider } from './brevo-provider';
import { InboxMailProvider } from './inbox-provider';

describe('createMailProvider', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // リセット
    delete process.env.MAIL_PROVIDER;
    delete process.env.BREVO_API_KEY;
    delete process.env.RESEND_API_KEY;
    delete process.env.INBOX_DIR;
    delete process.env.MAIL_FROM;
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

  it('MAIL_PROVIDER=brevo + BREVO_API_KEY + MAIL_FROM 設定済みで BrevoMailProvider を返す', () => {
    process.env.MAIL_PROVIDER = 'brevo';
    process.env.BREVO_API_KEY = 'test-key';
    process.env.MAIL_FROM = 'noreply@example.com';
    const provider = createMailProvider();
    expect(provider).toBeInstanceOf(BrevoMailProvider);
  });

  it('MAIL_PROVIDER=brevo + BREVO_API_KEY 未設定で ConsoleMailProvider にフォールバック', () => {
    process.env.MAIL_PROVIDER = 'brevo';
    process.env.MAIL_FROM = 'noreply@example.com';
    const provider = createMailProvider();
    expect(provider).toBeInstanceOf(ConsoleMailProvider);
  });

  // 2026-05-13 (security/config-hardening, B-7): MAIL_FROM 未設定での brevo は console fallback
  it('MAIL_PROVIDER=brevo + MAIL_FROM 未設定で ConsoleMailProvider にフォールバック (B-7)', () => {
    process.env.MAIL_PROVIDER = 'brevo';
    process.env.BREVO_API_KEY = 'test-key';
    // MAIL_FROM はあえて未設定
    const provider = createMailProvider();
    expect(provider).toBeInstanceOf(ConsoleMailProvider);
  });

  it('MAIL_PROVIDER=resend + RESEND_API_KEY + MAIL_FROM 設定済みで ResendMailProvider を返す', () => {
    process.env.MAIL_PROVIDER = 'resend';
    process.env.RESEND_API_KEY = 'test-key';
    process.env.MAIL_FROM = 'noreply@example.com';
    const provider = createMailProvider();
    expect(provider).toBeInstanceOf(ResendMailProvider);
  });

  it('MAIL_PROVIDER=resend + RESEND_API_KEY 未設定で ConsoleMailProvider にフォールバック', () => {
    process.env.MAIL_PROVIDER = 'resend';
    process.env.MAIL_FROM = 'noreply@example.com';
    const provider = createMailProvider();
    expect(provider).toBeInstanceOf(ConsoleMailProvider);
  });

  // 2026-05-13 (security/config-hardening, B-7): MAIL_FROM 未設定での resend は console fallback
  it('MAIL_PROVIDER=resend + MAIL_FROM 未設定で ConsoleMailProvider にフォールバック (B-7)', () => {
    process.env.MAIL_PROVIDER = 'resend';
    process.env.RESEND_API_KEY = 'test-key';
    // MAIL_FROM はあえて未設定
    const provider = createMailProvider();
    expect(provider).toBeInstanceOf(ConsoleMailProvider);
  });

  it('PR #92: MAIL_PROVIDER=inbox + INBOX_DIR 設定済みで InboxMailProvider を返す', () => {
    const dir = mkdtempSync(join(tmpdir(), 'inbox-test-'));
    try {
      process.env.MAIL_PROVIDER = 'inbox';
      process.env.INBOX_DIR = dir;
      const provider = createMailProvider();
      expect(provider).toBeInstanceOf(InboxMailProvider);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('PR #92: MAIL_PROVIDER=inbox + INBOX_DIR 未設定で ConsoleMailProvider にフォールバック', () => {
    process.env.MAIL_PROVIDER = 'inbox';
    const provider = createMailProvider();
    expect(provider).toBeInstanceOf(ConsoleMailProvider);
  });
});
