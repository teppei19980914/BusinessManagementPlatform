import { describe, it, expect } from 'vitest';
import {
  DEFAULT_TIMEZONE,
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  SELECTABLE_LOCALES,
  resolveTimezone,
  resolveLocale,
  isSupportedLocale,
  isSelectableLocale,
  isValidTimezone,
} from './i18n';

/**
 * PR #118 (2026-04-24): i18n 設定の 3 段階フォールバックを検証。
 * 注: env による上書きは module 初期化時に評価されるため、ここでは resolveXxx
 * の **ユーザ→システム** のフォールバック (env→FALLBACK は未テスト) を中心に検証。
 */

describe('DEFAULT_TIMEZONE / DEFAULT_LOCALE', () => {
  it('非空文字列である', () => {
    expect(DEFAULT_TIMEZONE.length).toBeGreaterThan(0);
    expect(DEFAULT_LOCALE.length).toBeGreaterThan(0);
  });

  it('Intl.DateTimeFormat が受理できる値である', () => {
    expect(() => new Intl.DateTimeFormat(DEFAULT_LOCALE, { timeZone: DEFAULT_TIMEZONE })).not.toThrow();
  });
});

describe('resolveTimezone', () => {
  it('ユーザ値が指定されていればそれを使う', () => {
    expect(resolveTimezone('America/New_York')).toBe('America/New_York');
  });

  it('null / undefined / 空文字列 / 空白のみは DEFAULT_TIMEZONE にフォールバック', () => {
    expect(resolveTimezone(null)).toBe(DEFAULT_TIMEZONE);
    expect(resolveTimezone(undefined)).toBe(DEFAULT_TIMEZONE);
    expect(resolveTimezone('')).toBe(DEFAULT_TIMEZONE);
    expect(resolveTimezone('   ')).toBe(DEFAULT_TIMEZONE);
  });

  it('前後の空白を除去した値が有効ならそれを採用する', () => {
    expect(resolveTimezone('  Asia/Tokyo  ')).toBe('Asia/Tokyo');
  });
});

describe('resolveLocale', () => {
  it('ユーザ値が指定されていればそれを使う', () => {
    expect(resolveLocale('en-US')).toBe('en-US');
  });

  it('null / undefined / 空文字列 / 空白のみは DEFAULT_LOCALE にフォールバック', () => {
    expect(resolveLocale(null)).toBe(DEFAULT_LOCALE);
    expect(resolveLocale(undefined)).toBe(DEFAULT_LOCALE);
    expect(resolveLocale('')).toBe(DEFAULT_LOCALE);
    expect(resolveLocale('   ')).toBe(DEFAULT_LOCALE);
  });
});

describe('isSupportedLocale', () => {
  it('SUPPORTED_LOCALES のキーを受理する', () => {
    for (const key of Object.keys(SUPPORTED_LOCALES)) {
      expect(isSupportedLocale(key)).toBe(true);
    }
  });

  it('未対応値は false', () => {
    expect(isSupportedLocale('de-DE')).toBe(false);
    expect(isSupportedLocale('')).toBe(false);
    expect(isSupportedLocale(null)).toBe(false);
    expect(isSupportedLocale(undefined)).toBe(false);
    expect(isSupportedLocale(123)).toBe(false);
  });
});

describe('SELECTABLE_LOCALES / isSelectableLocale (PR #120)', () => {
  it('SUPPORTED_LOCALES の全キーに対して true/false が定義されている', () => {
    for (const key of Object.keys(SUPPORTED_LOCALES)) {
      expect(typeof SELECTABLE_LOCALES[key as keyof typeof SELECTABLE_LOCALES]).toBe('boolean');
    }
  });

  it('ja-JP は選択可', () => {
    expect(SELECTABLE_LOCALES['ja-JP']).toBe(true);
    expect(isSelectableLocale('ja-JP')).toBe(true);
  });

  it('en-US は選択不可 (後続 PR で翻訳完了後に有効化予定)', () => {
    expect(SELECTABLE_LOCALES['en-US']).toBe(false);
    expect(isSelectableLocale('en-US')).toBe(false);
  });

  it('SUPPORTED_LOCALES に含まれない値は false', () => {
    expect(isSelectableLocale('de-DE')).toBe(false);
    expect(isSelectableLocale('')).toBe(false);
    expect(isSelectableLocale(null)).toBe(false);
    expect(isSelectableLocale(undefined)).toBe(false);
  });

  it('isSupportedLocale は en-US も true を返す (format 層は過去値を許容する設計)', () => {
    expect(isSupportedLocale('en-US')).toBe(true);
  });
});

describe('isValidTimezone', () => {
  it('IANA タイムゾーンを受理する', () => {
    expect(isValidTimezone('Asia/Tokyo')).toBe(true);
    expect(isValidTimezone('America/New_York')).toBe(true);
    expect(isValidTimezone('UTC')).toBe(true);
  });

  it('未知の値 / 空文字列 / 非文字列は false', () => {
    expect(isValidTimezone('Not/A_Zone')).toBe(false);
    expect(isValidTimezone('')).toBe(false);
    expect(isValidTimezone('   ')).toBe(false);
    expect(isValidTimezone(null)).toBe(false);
    expect(isValidTimezone(undefined)).toBe(false);
    expect(isValidTimezone(42)).toBe(false);
  });
});
