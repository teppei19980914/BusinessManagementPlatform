import { describe, it, expect } from 'vitest';
import { isSafeCallbackUrl, sanitizeCallbackUrl } from './url-utils';

// CWE-601 Open Redirect 対策 (PR #198)。phishing 経路を作らないために
// 外部 URL / スキーマ相対 URL / javascript: スキーマ等を確実に拒否する。

describe('isSafeCallbackUrl', () => {
  describe('受理されるべき同一オリジン path', () => {
    it.each([
      ['/'],
      ['/projects'],
      ['/projects/abc-123'],
      ['/projects/abc?tab=members'],
      ['/projects/abc#section'],
      ['/projects?suggestions=1&filter=foo'],
      ['/admin/users'],
    ])('%s は受理される', (url) => {
      expect(isSafeCallbackUrl(url)).toBe(true);
    });
  });

  describe('拒否されるべき外部 / 危険 URL', () => {
    it.each([
      ['https://evil.example.com/login', '完全 URL (https)'],
      ['http://evil.example.com', '完全 URL (http)'],
      ['//evil.example.com/login', 'スキーマ相対 URL → 同一スキーマで外部へ'],
      ['javascript:alert(1)', 'XSS スキーマ'],
      ['data:text/html,<script>', 'data URL'],
      ['\\\\evil.com\\share', 'UNC 風パス'],
      ['/path\\with\\backslash', 'バックスラッシュ混入で解釈ずれの罠'],
      ['', '空文字'],
      ['  ', '空白のみ'],
      ['relative/path', '相対パス (絶対 / で始まらない)'],
      ['./relative', '相対パス (./)'],
      ['../parent', '相対パス (../)'],
      ['#hash', 'fragment のみ (絶対パス指定なし)'],
      ['?query', 'query のみ'],
    ])('%s (%s) は拒否される', (url) => {
      expect(isSafeCallbackUrl(url)).toBe(false);
    });

    it('null / undefined を拒否', () => {
      expect(isSafeCallbackUrl(null)).toBe(false);
      expect(isSafeCallbackUrl(undefined)).toBe(false);
    });

    it('文字列以外を拒否 (型保証外の入力)', () => {
      expect(isSafeCallbackUrl(123 as unknown as string)).toBe(false);
      expect(isSafeCallbackUrl({} as unknown as string)).toBe(false);
    });
  });
});

describe('sanitizeCallbackUrl', () => {
  it('安全な URL はそのまま返す', () => {
    expect(sanitizeCallbackUrl('/projects')).toBe('/projects');
  });

  it('危険な URL は fallback ("/") に置き換える', () => {
    expect(sanitizeCallbackUrl('https://evil.com')).toBe('/');
    expect(sanitizeCallbackUrl('//evil.com')).toBe('/');
    expect(sanitizeCallbackUrl(null)).toBe('/');
    expect(sanitizeCallbackUrl(undefined)).toBe('/');
  });

  it('fallback を明示指定できる (multi-tenant 等の用途)', () => {
    expect(sanitizeCallbackUrl('https://evil.com', '/dashboard')).toBe('/dashboard');
  });
});
