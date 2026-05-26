/**
 * ファイル本文テキスト抽出サービス (ADR-0021 §3.1 / 2026-05-26)
 *
 * 役割:
 *   添付ファイルのバイナリから本文テキストを抽出し、Voyage embedding 生成の入力にする。
 *   embedding 生成自体は別サービス (attachment-embedding.service.ts) が担当。
 *
 * 対応形式 (= EMBEDDING_SUPPORTED_EXTENSIONS):
 *   - .pdf   → pdf-parse で本文抽出
 *   - .xlsx / .xls → xlsx (sheetjs) で sheet → CSV 変換 → 結合
 *   - .csv   → csv-parse でパース → 結合
 *   - .txt / .md / .json → UTF-8 デコード
 *   - .docx  → mammoth で本文抽出
 *
 * 設計判断:
 *   - 重い parser ライブラリは dynamic import (= 起動時メモリ削減 + tree-shake)
 *   - 抽出失敗は throw せず result.error にメッセージを格納 (= 部分失敗でも他のファイルは継続)
 *   - 出力テキストは MAX_EXTRACTED_TEXT_CHARS (= 100,000 文字) で切詰
 *     (Voyage 1 input 32,000 tokens ≒ 100KB 上限、安全マージン込み)
 *   - SHA-256 hash を返す → 同一内容ファイルの重複 embedding 防止 + 改ざん検知
 *
 * 関連:
 *   - 危険拡張子判定: src/config/file-storage-pricing.ts isDangerousExtension()
 *   - embedding 対象判定: src/config/file-storage-pricing.ts isEmbeddingSupported()
 *   - embedding 生成: src/services/attachment-embedding.service.ts
 *   - upload API: src/app/api/attachments/upload + /finalize
 */

import { createHash } from 'node:crypto';
import { parse as csvParseSync } from 'csv-parse/sync';
import {
  EMBEDDING_SUPPORTED_EXTENSIONS,
  getFileExtension,
} from '../config/file-storage-pricing';

/** 抽出テキストの最大文字数。Voyage 1 input ~32K tokens (≒ 100K 文字) を上限とする */
export const MAX_EXTRACTED_TEXT_CHARS = 100_000;

/**
 * ★ KDD §5.X+149: parser に渡す buffer の上限 (= OOM 対策)。
 *   pdf-parse / exceljs / mammoth はバイナリ全体をメモリにロードして処理する。
 *   50MB の Excel に数千の formula があると Netlify Function (1GB 上限) で OOM 発生。
 *   ファイル本体上限は 50MB (= FILE_STORAGE_MAX_FILE_SIZE_BYTES) のため、
 *   それと同じ 50MB を本値の上限とする。これを超える buffer は 'unsupported' 扱い。
 */
export const MAX_EXTRACTION_BUFFER_BYTES = 50 * 1_000_000;

export type ExtractionResult =
  | { kind: 'success'; text: string; sha256: string; sourceFormat: string }
  | { kind: 'unsupported'; reason: string }
  | { kind: 'error'; error: string; sourceFormat: string };

// テスト用 parser 差し替えポイント
type PdfParser = (buffer: Buffer) => Promise<{ text: string }>;
type XlsxParser = (buffer: Buffer) => Promise<string>;
type DocxParser = (buffer: Buffer) => Promise<string>;

let pdfParserOverride: PdfParser | null = null;
let xlsxParserOverride: XlsxParser | null = null;
let docxParserOverride: DocxParser | null = null;

/** テスト専用: parser を差し替える */
export function _setExtractorsForTest(opts: {
  pdf?: PdfParser | null;
  xlsx?: XlsxParser | null;
  docx?: DocxParser | null;
}): void {
  if (opts.pdf !== undefined) pdfParserOverride = opts.pdf;
  if (opts.xlsx !== undefined) xlsxParserOverride = opts.xlsx;
  if (opts.docx !== undefined) docxParserOverride = opts.docx;
}

/**
 * ファイル本文を抽出する。
 *
 * @param fileName ファイル名 (拡張子から format を判定)
 * @param buffer   ファイルバイナリ
 * @returns ExtractionResult — success / unsupported / error の 3 値
 */
export async function extractText(
  fileName: string,
  buffer: Buffer,
): Promise<ExtractionResult> {
  const ext = getFileExtension(fileName);

  if (!EMBEDDING_SUPPORTED_EXTENSIONS.includes(ext)) {
    return { kind: 'unsupported', reason: `extension ${ext || '(none)'} is not supported` };
  }

  // KDD §5.X+149: OOM 対策。50MB 超 buffer は parser に渡さず 'unsupported' で返却。
  //   (実運用ではアップロード時に 50MB cap されているが defense-in-depth)
  if (buffer.byteLength > MAX_EXTRACTION_BUFFER_BYTES) {
    return {
      kind: 'unsupported',
      reason: `buffer too large (${buffer.byteLength} bytes > ${MAX_EXTRACTION_BUFFER_BYTES} bytes)`,
    };
  }

  try {
    let rawText: string;
    switch (ext) {
      case '.txt':
      case '.md':
      case '.json':
        rawText = buffer.toString('utf8');
        break;
      case '.csv':
        rawText = extractCsv(buffer);
        break;
      case '.pdf':
        rawText = await extractPdf(buffer);
        break;
      case '.xlsx':
      case '.xls':
        rawText = await extractXlsx(buffer);
        break;
      case '.docx':
        rawText = await extractDocx(buffer);
        break;
      default:
        return { kind: 'unsupported', reason: `extension ${ext} has no handler` };
    }

    const normalized = normalizeText(rawText);
    if (normalized.length === 0) {
      return { kind: 'error', error: 'extracted text is empty', sourceFormat: ext };
    }
    const truncated = normalized.slice(0, MAX_EXTRACTED_TEXT_CHARS);
    const sha256 = createHash('sha256').update(truncated, 'utf8').digest('hex');

    return { kind: 'success', text: truncated, sha256, sourceFormat: ext };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { kind: 'error', error: msg, sourceFormat: ext };
  }
}

function normalizeText(s: string): string {
  return s
    .replace(/\r\n?/g, '\n')
    // PDF 抽出で稀に混入する NULL バイトを除去。
    // ⚠️ KDD §5.X+143: 必ず \x00 エスケープで書く。リテラル NUL バイトを埋めると
    // git が source を binary 判定し diff が hide される事故あり (PR #445 で実例)。
    .replace(/\x00/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractCsv(buffer: Buffer): string {
  const records: string[][] = csvParseSync(buffer.toString('utf8'), {
    skip_empty_lines: true,
    relax_column_count: true,
    relax_quotes: true,
  });
  return records.map((row) => row.join('\t')).join('\n');
}

async function extractPdf(buffer: Buffer): Promise<string> {
  const parser = pdfParserOverride ?? (await loadPdfParser());
  const result = await parser(buffer);
  return result.text;
}

async function loadPdfParser(): Promise<PdfParser> {
  const mod = await import('pdf-parse');
  const fn = (mod as { default?: (b: Buffer) => Promise<{ text: string }> }).default
    ?? (mod as unknown as (b: Buffer) => Promise<{ text: string }>);
  return async (buffer: Buffer) => fn(buffer);
}

async function extractXlsx(buffer: Buffer): Promise<string> {
  if (xlsxParserOverride) return xlsxParserOverride(buffer);
  // exceljs に切替え (xlsx@sheetjs は fix なし High CVE 2 件: GHSA-4r6h-8v6p-xvw6 + GHSA-5pgg-2g8v-p4x9)
  // KDD §5.X+140 参照
  const ExcelJS = (await import('exceljs')) as typeof import('exceljs');
  const workbook = new ExcelJS.Workbook();
  // exceljs の型定義は古い Buffer 型シグネチャを要求するため、ArrayBuffer 経由で渡す。
  // (Node 22+ の Buffer<ArrayBufferLike> ジェネリックとの不一致対応)
  await workbook.xlsx.load(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer);
  const sheets: string[] = [];
  workbook.eachSheet((worksheet) => {
    const rows: string[] = [`[${worksheet.name}]`];
    worksheet.eachRow({ includeEmpty: false }, (row) => {
      const cells: string[] = [];
      row.eachCell({ includeEmpty: false }, (cell) => {
        const value = cell.value;
        if (value === null || value === undefined) {
          cells.push('');
        } else if (typeof value === 'object' && 'text' in value) {
          // RichText / Hyperlink: 表示テキストのみ抽出
          cells.push(String((value as { text: unknown }).text ?? ''));
        } else if (typeof value === 'object' && 'result' in value) {
          // Formula: 計算結果のみ抽出
          cells.push(String((value as { result: unknown }).result ?? ''));
        } else if (value instanceof Date) {
          cells.push(value.toISOString());
        } else {
          cells.push(String(value));
        }
      });
      rows.push(cells.join('\t'));
    });
    sheets.push(rows.join('\n'));
  });
  return sheets.join('\n\n');
}

async function extractDocx(buffer: Buffer): Promise<string> {
  if (docxParserOverride) return docxParserOverride(buffer);
  const mammoth = (await import('mammoth')) as {
    extractRawText: (input: { buffer: Buffer }) => Promise<{ value: string }>;
  };
  const result = await mammoth.extractRawText({ buffer });
  return result.value;
}
