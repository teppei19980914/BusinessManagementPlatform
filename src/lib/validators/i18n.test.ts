import { describe, it, expect } from 'vitest';
import { updateI18nSchema } from './i18n';

/**
 * PR #119 + PR #120: i18n 設定更新のバリデータ。
 * PR #120 で locale は SELECTABLE_LOCALES=true のものだけ受理するよう厳格化。
 */

describe('updateI18nSchema', () => {
  it('有効な IANA タイムゾーン + 選択可能なロケールを受理する', () => {
    const result = updateI18nSchema.safeParse({
      timezone: 'America/New_York',
      locale: 'ja-JP',
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

  it('PR #175: en-US は Phase C 翻訳完了で SELECTABLE_LOCALES=true となり受理される', () => {
    const result = updateI18nSchema.safeParse({ locale: 'en-US' });
    expect(result.success).toBe(true);
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
