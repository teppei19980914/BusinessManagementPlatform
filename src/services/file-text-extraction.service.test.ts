/**
 * file-text-extraction.service.ts の単体テスト (ADR-0021 §3.1)
 *
 * 重要: parser ライブラリ (pdf-parse / xlsx / mammoth) は外部依存のため
 *   _setExtractorsForTest() でモック注入し、サービスのロジックのみ検証する。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  extractText,
  _setExtractorsForTest,
  MAX_EXTRACTED_TEXT_CHARS,
} from './file-text-extraction.service';

beforeEach(() => {
  _setExtractorsForTest({ pdf: null, xlsx: null, docx: null });
});

describe('extractText — 対応形式', () => {
  it('.txt → UTF-8 デコード成功', async () => {
    const buf = Buffer.from('hello world\nsecond line', 'utf8');
    const result = await extractText('memo.txt', buf);
    expect(result.kind).toBe('success');
    if (result.kind !== 'success') throw new Error();
    expect(result.text).toBe('hello world\nsecond line');
    expect(result.sourceFormat).toBe('.txt');
    expect(result.sha256).toHaveLength(64); // SHA-256 hex
  });

  it('.md → UTF-8 デコード成功', async () => {
    const buf = Buffer.from('# Header\n\nbody', 'utf8');
    const result = await extractText('README.md', buf);
    expect(result.kind).toBe('success');
    if (result.kind !== 'success') throw new Error();
    expect(result.text).toBe('# Header\n\nbody');
  });

  it('.json → UTF-8 デコード成功 (テキストとして扱う)', async () => {
    const buf = Buffer.from('{"key":"value"}', 'utf8');
    const result = await extractText('data.json', buf);
    expect(result.kind).toBe('success');
  });

  it('.csv → tab-joined 行に変換', async () => {
    const buf = Buffer.from('a,b,c\n1,2,3\n4,5,6', 'utf8');
    const result = await extractText('data.csv', buf);
    expect(result.kind).toBe('success');
    if (result.kind !== 'success') throw new Error();
    expect(result.text).toBe('a\tb\tc\n1\t2\t3\n4\t5\t6');
  });

  it('.csv → 空行スキップ', async () => {
    const buf = Buffer.from('a,b\n\n1,2\n\n', 'utf8');
    const result = await extractText('data.csv', buf);
    expect(result.kind).toBe('success');
    if (result.kind !== 'success') throw new Error();
    expect(result.text).toBe('a\tb\n1\t2');
  });

  it('.pdf → mock parser 経由で抽出', async () => {
    _setExtractorsForTest({ pdf: async () => ({ text: 'pdf content here' }) });
    const result = await extractText('doc.pdf', Buffer.from('fake-pdf'));
    expect(result.kind).toBe('success');
    if (result.kind !== 'success') throw new Error();
    expect(result.text).toBe('pdf content here');
  });

  it('.xlsx → mock parser 経由で抽出', async () => {
    _setExtractorsForTest({ xlsx: async () => '[Sheet1]\na\tb\n1\t2' });
    const result = await extractText('book.xlsx', Buffer.from('fake-xlsx'));
    expect(result.kind).toBe('success');
    if (result.kind !== 'success') throw new Error();
    expect(result.text).toContain('[Sheet1]');
  });

  it('.xls (旧形式) も同じ xlsx parser 経由', async () => {
    _setExtractorsForTest({ xlsx: async () => 'legacy xls' });
    const result = await extractText('legacy.xls', Buffer.from('fake'));
    expect(result.kind).toBe('success');
  });

  it('.docx → mock parser 経由で抽出', async () => {
    _setExtractorsForTest({ docx: async () => 'docx content here' });
    const result = await extractText('contract.docx', Buffer.from('fake-docx'));
    expect(result.kind).toBe('success');
    if (result.kind !== 'success') throw new Error();
    expect(result.text).toBe('docx content here');
  });
});

describe('extractText — 非対応形式', () => {
  it('.jpg → unsupported', async () => {
    const result = await extractText('photo.jpg', Buffer.from(''));
    expect(result.kind).toBe('unsupported');
  });

  it('.zip → unsupported', async () => {
    const result = await extractText('archive.zip', Buffer.from(''));
    expect(result.kind).toBe('unsupported');
  });

  it('拡張子なし → unsupported', async () => {
    const result = await extractText('README', Buffer.from(''));
    expect(result.kind).toBe('unsupported');
  });

  it('.mp4 (動画) → unsupported', async () => {
    const result = await extractText('video.mp4', Buffer.from(''));
    expect(result.kind).toBe('unsupported');
  });
});

describe('extractText — エラー処理', () => {
  it('parser が throw した場合は error 結果を返す (throw せず)', async () => {
    _setExtractorsForTest({
      pdf: async () => {
        throw new Error('PDF corrupted');
      },
    });
    const result = await extractText('doc.pdf', Buffer.from('fake'));
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') throw new Error();
    expect(result.error).toBe('PDF corrupted');
    expect(result.sourceFormat).toBe('.pdf');
  });

  it('抽出後が空文字なら error を返す', async () => {
    _setExtractorsForTest({ pdf: async () => ({ text: '   \n\n  ' }) });
    const result = await extractText('blank.pdf', Buffer.from('fake'));
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') throw new Error();
    expect(result.error).toContain('empty');
  });
});

describe('extractText — テキスト正規化 / 切詰', () => {
  it('CRLF → LF 変換', async () => {
    const buf = Buffer.from('a\r\nb\rc', 'utf8');
    const result = await extractText('memo.txt', buf);
    expect(result.kind).toBe('success');
    if (result.kind !== 'success') throw new Error();
    expect(result.text).toBe('a\nb\nc');
  });

  it('3 連以上の改行は 2 連に圧縮', async () => {
    const buf = Buffer.from('a\n\n\n\nb', 'utf8');
    const result = await extractText('memo.txt', buf);
    expect(result.kind).toBe('success');
    if (result.kind !== 'success') throw new Error();
    expect(result.text).toBe('a\n\nb');
  });

  it(`${MAX_EXTRACTED_TEXT_CHARS} 文字超過は切詰`, async () => {
    const huge = 'x'.repeat(MAX_EXTRACTED_TEXT_CHARS + 1000);
    const result = await extractText('huge.txt', Buffer.from(huge, 'utf8'));
    expect(result.kind).toBe('success');
    if (result.kind !== 'success') throw new Error();
    expect(result.text.length).toBe(MAX_EXTRACTED_TEXT_CHARS);
  });

  it('NULL バイト (\\x00) を除去 — PDF 抽出で稀に混入、後段の DB/embedding 投入で事故防止 (KDD §5.X+143)', async () => {
    const withNull = `before\x00middle\x00after`;
    const result = await extractText('memo.txt', Buffer.from(withNull, 'utf8'));
    expect(result.kind).toBe('success');
    if (result.kind !== 'success') throw new Error();
    expect(result.text).toBe('beforemiddleafter');
    expect(result.text).not.toContain('\x00');
  });
});

describe('extractText — SHA-256 hash', () => {
  it('同一テキストなら同じ hash', async () => {
    const r1 = await extractText('a.txt', Buffer.from('same content'));
    const r2 = await extractText('b.txt', Buffer.from('same content'));
    expect(r1.kind).toBe('success');
    expect(r2.kind).toBe('success');
    if (r1.kind !== 'success' || r2.kind !== 'success') throw new Error();
    expect(r1.sha256).toBe(r2.sha256);
  });

  it('異なるテキストなら異なる hash', async () => {
    const r1 = await extractText('a.txt', Buffer.from('content A'));
    const r2 = await extractText('b.txt', Buffer.from('content B'));
    if (r1.kind !== 'success' || r2.kind !== 'success') throw new Error();
    expect(r1.sha256).not.toBe(r2.sha256);
  });
});
