import { describe, it, expect } from 'vitest';
import {
  CSV_MAX_BYTES,
  CSV_MAX_ROWS,
  checkCsvSize,
  checkCsvRowCount,
  handleCsvParseError,
} from './csv-import-helpers';

// テスト用の最低限 translator (key を返すだけの mock — 本物の next-intl 連動は不要)
const t = (key: string, params?: Record<string, string | number | Date>) => {
  if (params) return `${key}:${JSON.stringify(params)}`;
  return key;
};

describe('csv-import-helpers (fix/csv-import-multiline-text-data-loss 2 巡目)', () => {
  describe('CSV_MAX_BYTES', () => {
    it('10 MB に設定されている (sync-import の 500 件上限 × 平均 2KB の 10 倍マージン)', () => {
      expect(CSV_MAX_BYTES).toBe(10 * 1024 * 1024);
    });
  });

  describe('checkCsvSize', () => {
    it('上限以下なら null を返す (= 通過)', async () => {
      expect(checkCsvSize('a,b,c\n1,2,3', t)).toBeNull();
    });

    it('上限超過なら 413 NextResponse を返す', async () => {
      const big = 'a'.repeat(CSV_MAX_BYTES + 1);
      const res = checkCsvSize(big, t);
      expect(res).not.toBeNull();
      expect(res!.status).toBe(413);
      const body = await res!.json();
      expect(body.error.code).toBe('CSV_SIZE_EXCEEDED');
      expect(body.error.message).toContain('csvSizeExceeded');
    });

    it('UTF-8 マルチバイト文字も Byte 長で判定する (日本語 3 倍程度)', async () => {
      // 「あ」(3 bytes) を上限ギリギリまで詰める
      const chars = Math.ceil(CSV_MAX_BYTES / 3) + 1;
      const big = 'あ'.repeat(chars);
      const res = checkCsvSize(big, t);
      expect(res).not.toBeNull();
      expect(res!.status).toBe(413);
    });

    it('境界値 (= 上限ちょうど) は通過する', () => {
      const exact = 'a'.repeat(CSV_MAX_BYTES);
      expect(checkCsvSize(exact, t)).toBeNull();
    });
  });

  describe('CSV_MAX_ROWS / checkCsvRowCount (2026-05-28 フルスキャン 2 巡目で追加)', () => {
    it('500 行に設定されている (CSV_MAX_BYTES コメントで参照されていた設計値)', () => {
      expect(CSV_MAX_ROWS).toBe(500);
    });

    it('上限以下なら null を返す (= 通過)', () => {
      expect(checkCsvRowCount(0, t)).toBeNull();
      expect(checkCsvRowCount(1, t)).toBeNull();
      expect(checkCsvRowCount(CSV_MAX_ROWS, t)).toBeNull();
    });

    it('上限超過なら 413 NextResponse を返す', async () => {
      const res = checkCsvRowCount(CSV_MAX_ROWS + 1, t);
      expect(res).not.toBeNull();
      expect(res!.status).toBe(413);
      const body = await res!.json();
      expect(body.error.code).toBe('CSV_ROW_COUNT_EXCEEDED');
      expect(body.error.message).toContain('csvRowCountExceeded');
      expect(body.error.message).toContain(String(CSV_MAX_ROWS));
    });

    it('境界値 (= 上限ちょうど) は通過する', () => {
      expect(checkCsvRowCount(CSV_MAX_ROWS, t)).toBeNull();
    });

    it('大量の行数 (10000) も適切に拒否する', () => {
      const res = checkCsvRowCount(10_000, t);
      expect(res!.status).toBe(413);
    });
  });

  describe('handleCsvParseError', () => {
    it('CsvError っぽい Error (code が CSV_*) は 400 NextResponse', async () => {
      const e = Object.assign(new Error('Quote Not Closed'), {
        name: 'CsvError',
        code: 'CSV_QUOTE_NOT_CLOSED',
      });
      const res = handleCsvParseError(e, t);
      expect(res).not.toBeNull();
      expect(res!.status).toBe(400);
      const body = await res!.json();
      expect(body.error.code).toBe('CSV_PARSE_ERROR');
      expect(body.error.message).toContain('csvParseError');
      expect(body.error.message).toContain('Quote Not Closed');
    });

    it('name=CsvError でも code 無しでも検出する', async () => {
      const e = Object.assign(new Error('parse error'), { name: 'CsvError' });
      const res = handleCsvParseError(e, t);
      expect(res).not.toBeNull();
      expect(res!.status).toBe(400);
    });

    it('CSV_* code を持つだけの Error も検出する (name 未設定)', async () => {
      const e = Object.assign(new Error('detail'), { code: 'CSV_INVALID_CLOSING_QUOTE' });
      const res = handleCsvParseError(e, t);
      expect(res!.status).toBe(400);
    });

    it('csv-parse 由来でない Error は null を返す (= 上位 catch に委ねる)', () => {
      expect(handleCsvParseError(new Error('random error'), t)).toBeNull();
    });

    it('非 Error 値 (string / null) も null を返す', () => {
      expect(handleCsvParseError('string', t)).toBeNull();
      expect(handleCsvParseError(null, t)).toBeNull();
      expect(handleCsvParseError(undefined, t)).toBeNull();
    });
  });
});
