import { describe, it, expect } from 'vitest';
import { updateI18nSchema } from './i18n';

/**
 * PR #119: i18n 設定更新のバリデータ。
 */

describe('updateI18nSchema', () => {
  it('有効な IANA タイムゾーン + サポート ロケールを受理する', () => {
    const result = updateI18nSchema.safeParse({
      timezone: 'America/New_York',
      locale: 'en-US',
    });
    expect(result.success).toBe(true);
  });

  it('timezone のみ / locale のみの部分更新を受理する', () => {
    expect(updateI18nSchema.safeParse({ timezone: 'UTC' }).success).toBe(true);
    expect(updateI18nSchema.safeParse({ locale: 'ja-JP' }).success).toBe(true);
  });

  it('null を受理する (システム既定に戻す意味)', () => {
    expect(updateI18nSchema.safeParse({ timezone: null, locale: null }).success).toBe(true);
  });

  it('空オブジェクトを受理する (no-op)', () => {
    expect(updateI18nSchema.safeParse({}).success).toBe(true);
  });

  it('未知の timezone を拒否する (DB 汚染防止)', () => {
    const result = updateI18nSchema.safeParse({ timezone: 'Not/A_Zone' });
    expect(result.success).toBe(false);
  });

  it('SUPPORTED_LOCALES にない locale を拒否する', () => {
    const result = updateI18nSchema.safeParse({ locale: 'de-DE' });
    expect(result.success).toBe(false);
  });

  it('空文字列の timezone を拒否する', () => {
    const result = updateI18nSchema.safeParse({ timezone: '' });
    expect(result.success).toBe(false);
  });

  it('数値等の非文字列型を拒否する', () => {
    const result = updateI18nSchema.safeParse({ timezone: 123, locale: 456 });
    expect(result.success).toBe(false);
  });
});
