/**
 * 5 entity の sync-import API route が共通で必要とする CSV 入力ガード。
 *
 * 役割:
 *   - サイズ上限 (DoS 緩和) の事前判定
 *   - csv-parse 由来の CsvError を 4xx に正規化 (旧自前 parser は throw しなかったが
 *     RFC 4180 準拠ライブラリは malformed CSV で throw するため 500 になる退行を防ぐ)
 *
 * 設計判断:
 *   - 5 route 個別実装は同型コード複製 → multi-line cell silent data loss と同じ轍を踏むため
 *     共有関数に集約 (fix/csv-import-multiline-text-data-loss 2 巡目フルスキャンで規約化)
 *   - NextResponse を返すパターンに統一して route 側の分岐を最小化
 */

import { NextResponse } from 'next/server';

/** CSV 1 ファイルあたりの最大サイズ。
 *  - sync-import の `csvRows.length > 500` 制限から逆算: 平均 1 行 2KB × 500 件 = ~1MB
 *  - 安全マージン 10 倍で 10MB に設定 (Excel で textarea 含む CSV を編集した実例上限)
 *  - Next.js の default body size (4.5MB on Vercel / Netlify) より大きいが、route handler の
 *    formData() は内部的に chunk 読み込みするため明示チェックが必要
 */
export const CSV_MAX_BYTES = 10 * 1024 * 1024;

/**
 * CSV サイズチェック。上限超なら 413 Response を返し、route 側で早期 return できる。
 *
 * UTF-8 の Byte 長で判定 (.length の文字数ではない、日本語が 3 倍程度のため)。
 *
 * @returns 上限超なら 413 NextResponse、問題なければ null
 */
export function checkCsvSize(csvText: string, t: (k: string, p?: Record<string, string | number | Date>) => string): NextResponse | null {
  const byteLen = Buffer.byteLength(csvText, 'utf8');
  if (byteLen > CSV_MAX_BYTES) {
    return NextResponse.json(
      {
        error: {
          code: 'CSV_SIZE_EXCEEDED',
          message: t('csvSizeExceeded', { maxMb: Math.floor(CSV_MAX_BYTES / 1024 / 1024) }),
        },
      },
      { status: 413 },
    );
  }
  return null;
}

/**
 * csv-parse 由来のエラーかを判定し、400 Response にラップする。
 *
 * csv-parse は CsvError (code が `CSV_*` 形式の文字列) を throw する。代表的なケース:
 *   - CSV_QUOTE_NOT_CLOSED: 閉じてないクォート (EOF 到達)
 *   - CSV_INVALID_CLOSING_QUOTE: クォートの次が `,` や改行でない (例: `"a"x,b`)
 *   - CSV_NON_TRIMABLE_CHAR_AFTER_CLOSING_QUOTE: クォート閉じ後に空白以外
 *   - CSV_MAX_RECORD_SIZE: max_record_size 超過 (本プロジェクトでは未指定なので発生しない)
 *
 * これらは「ユーザの編集ミス」起因なので 500 ではなく 400 (バリデーションエラー)。
 *
 * @returns csv-parse エラーなら 400 NextResponse、別種のエラーなら null
 */
export function handleCsvParseError(e: unknown, t: (k: string, p?: Record<string, string | number | Date>) => string): NextResponse | null {
  if (!(e instanceof Error)) return null;
  // csv-parse の CsvError は `code` プロパティを持つ + name が 'CsvError'
  const code = (e as { code?: unknown }).code;
  const isCsvError = e.name === 'CsvError' || (typeof code === 'string' && code.startsWith('CSV_'));
  if (!isCsvError) return null;
  return NextResponse.json(
    {
      error: {
        code: 'CSV_PARSE_ERROR',
        message: t('csvParseError', { detail: e.message }),
      },
    },
    { status: 400 },
  );
}
