import { afterEach, describe, expect, it } from 'vitest';
import {
  formatVersionLabel,
  getAppVersion,
  getReleaseDate,
} from './app-version';

/**
 * `NEXT_PUBLIC_APP_VERSION` / `NEXT_PUBLIC_RELEASE_DATE` は next.config.ts が build 時に
 * inline 化するが、Vitest 実行時は通常の `process.env` として参照できる。
 * テストではこの値を退避 → 上書き → 復元する。
 */
describe('app-version', () => {
  const originalVersion = process.env.NEXT_PUBLIC_APP_VERSION;
  const originalReleaseDate = process.env.NEXT_PUBLIC_RELEASE_DATE;

  afterEach(() => {
    process.env.NEXT_PUBLIC_APP_VERSION = originalVersion;
    process.env.NEXT_PUBLIC_RELEASE_DATE = originalReleaseDate;
  });

  describe('getAppVersion', () => {
    it('注入済の値を返す', () => {
      process.env.NEXT_PUBLIC_APP_VERSION = '1.2.3';
      expect(getAppVersion()).toBe('1.2.3');
    });

    it('未注入時はフォールバック値を返す', () => {
      delete process.env.NEXT_PUBLIC_APP_VERSION;
      expect(getAppVersion()).toBe('0.0.0-dev');
    });

    it('空文字時もフォールバック値を返す', () => {
      process.env.NEXT_PUBLIC_APP_VERSION = '';
      expect(getAppVersion()).toBe('0.0.0-dev');
    });
  });

  describe('getReleaseDate', () => {
    it('ISO-8601 日付形式の値を返す', () => {
      process.env.NEXT_PUBLIC_RELEASE_DATE = '2026-06-01';
      expect(getReleaseDate()).toBe('2026-06-01');
    });

    it('未注入時はフォールバック値を返す', () => {
      delete process.env.NEXT_PUBLIC_RELEASE_DATE;
      expect(getReleaseDate()).toBe('2026-06-01');
    });

    it('不正な形式 (YYYY/MM/DD 等) はフォールバックする — 誤値が build に紛れた場合の防御', () => {
      process.env.NEXT_PUBLIC_RELEASE_DATE = '2026/06/01';
      expect(getReleaseDate()).toBe('2026-06-01');
    });

    it('完全に異形 (空文字含む) はフォールバックする', () => {
      process.env.NEXT_PUBLIC_RELEASE_DATE = 'invalid';
      expect(getReleaseDate()).toBe('2026-06-01');
    });
  });

  describe('formatVersionLabel', () => {
    it('"v{version} ({date})" 形式に整形する', () => {
      process.env.NEXT_PUBLIC_APP_VERSION = '1.0.0';
      process.env.NEXT_PUBLIC_RELEASE_DATE = '2026-06-01';
      expect(formatVersionLabel()).toBe('v1.0.0 (2026-06-01)');
    });
  });
});
