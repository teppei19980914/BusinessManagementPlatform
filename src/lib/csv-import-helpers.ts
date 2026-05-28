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

/** sync-import 1 ファイルあたりの最大行数 (ヘッダ除く data 行)。
 *  - 設計意図: CSV_MAX_BYTES のコメントで参照されてきた値だが、実装側 (5 sync-import service)
 *    では実際の行数チェックが未実装で silent skip (`fields.length < 3`) のみだった。
 *  - 2026-05-28 フルスキャン 2 巡目検証で発覚 → 明示的な 500 行制限を共通ヘルパに集約。
 *  - 1 業務操作で 500 件超を一括取込する UX 想定は無く、Excel での編集効率も劣化するため
 *    分割を促す。大量初回取込は経路 A (external-import) の 5000 行制限を使う。
 */
export const CSV_MAX_ROWS = 500;

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
 * sync-import 行数チェック。CSV_MAX_ROWS (500 行) 超なら 413 Response を返す。
 *
 * 設計判断: 「ファイル全文の Byte 数」と「parse 後の data 行数」は別軸で判定する必要がある。
 *   - 10MB CSV でも 1 行が巨大な multi-line cell かもしれない (= 行数少)
 *   - 500 行の textarea CSV でもサイズが 1MB 未満かもしれない (= サイズ少)
 *   いずれも DoS / UX 観点で個別に上限を設けたい。
 *
 * 呼出位置: parseXxxSyncImportCsv の戻り値 length を渡す。
 *
 * @returns 上限超なら 413 NextResponse、問題なければ null
 */
export function checkCsvRowCount(
  rowCount: number,
  t: (k: string, p?: Record<string, string | number | Date>) => string,
): NextResponse | null {
  if (rowCount > CSV_MAX_ROWS) {
    return NextResponse.json(
      {
        error: {
          code: 'CSV_ROW_COUNT_EXCEEDED',
          message: t('csvRowCountExceeded', { maxRows: CSV_MAX_ROWS }),
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
