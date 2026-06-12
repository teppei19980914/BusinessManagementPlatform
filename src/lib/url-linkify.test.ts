import { describe, it, expect } from 'vitest';
import { splitByUrl, containsUrl, type LinkifySegment } from './url-linkify';

/** テスト可読性のためのヘルパ: URL セグメントの値だけを取り出す。 */
function urls(segments: LinkifySegment[]): string[] {
  return segments.filter((s) => s.type === 'url').map((s) => s.value);
}

/** セグメントを連結すると必ず元テキストに戻る (情報欠落が無い) ことを保証。 */
function joined(segments: LinkifySegment[]): string {
  return segments.map((s) => s.value).join('');
}

describe('splitByUrl', () => {
  it('空文字は空配列', () => {
    expect(splitByUrl('')).toEqual([]);
  });

  it('URL を含まないテキストは text 1 セグメント', () => {
    const segs = splitByUrl('普通の説明文です。');
    expect(segs).toEqual([{ type: 'text', value: '普通の説明文です。' }]);
  });

  it('単独の URL をリンク化', () => {
    const segs = splitByUrl('https://tasukiba.com/login');
    expect(urls(segs)).toEqual(['https://tasukiba.com/login']);
  });

  it('★日本語が空白なしで直後に続く場合、URL 部分だけをリンク化する', () => {
    const segs = splitByUrl('https://tasukiba.com/loginにアクセスしてください。');
    expect(urls(segs)).toEqual(['https://tasukiba.com/login']);
    expect(segs).toEqual([
      { type: 'url', value: 'https://tasukiba.com/login' },
      { type: 'text', value: 'にアクセスしてください。' },
    ]);
    expect(joined(segs)).toBe('https://tasukiba.com/loginにアクセスしてください。');
  });

  it('文章の途中に URL がある場合 (前後にテキスト)', () => {
    const segs = splitByUrl('詳細は https://example.com/page を参照してください');
    expect(urls(segs)).toEqual(['https://example.com/page']);
    expect(joined(segs)).toBe('詳細は https://example.com/page を参照してください');
  });

  it('URL 直後の半角ピリオド (文末) は URL に含めない', () => {
    const segs = splitByUrl('See https://example.com/page.');
    expect(urls(segs)).toEqual(['https://example.com/page']);
    expect(joined(segs)).toBe('See https://example.com/page.');
  });

  it('URL 直後の全角句点 (。) は URL に含めない', () => {
    const segs = splitByUrl('https://example.com/page。続き');
    expect(urls(segs)).toEqual(['https://example.com/page']);
  });

  it('複数の URL を個別にリンク化', () => {
    const segs = splitByUrl('A https://a.example.com B https://b.example.com C');
    expect(urls(segs)).toEqual(['https://a.example.com', 'https://b.example.com']);
    expect(joined(segs)).toBe('A https://a.example.com B https://b.example.com C');
  });

  it('http も対象', () => {
    const segs = splitByUrl('http://example.com/x');
    expect(urls(segs)).toEqual(['http://example.com/x']);
  });

  it('クエリ・フラグメント・ポートを含む URL を保持', () => {
    const url = 'https://example.com:8443/path?a=1&b=2#sec';
    const segs = splitByUrl(`${url} を確認`);
    expect(urls(segs)).toEqual([url]);
  });

  it('文章の括弧の中の URL: 末尾の閉じ括弧は URL 外', () => {
    const segs = splitByUrl('(詳細は https://example.com/page)');
    expect(urls(segs)).toEqual(['https://example.com/page']);
    expect(joined(segs)).toBe('(詳細は https://example.com/page)');
  });

  it('URL 内で対応の取れた括弧は保持する (Wikipedia 等)', () => {
    const url = 'https://ja.wikipedia.org/wiki/Foo_(bar)';
    const segs = splitByUrl(url);
    expect(urls(segs)).toEqual([url]);
  });

  it('末尾の感嘆符・読点は URL 外', () => {
    expect(urls(splitByUrl('https://example.com!'))).toEqual(['https://example.com']);
    expect(urls(splitByUrl('https://example.com, 次'))).toEqual(['https://example.com']);
  });

  it('ftp / mailto / 裸の www. はリンク化しない (http/https のみ)', () => {
    expect(urls(splitByUrl('ftp://example.com/x'))).toEqual([]);
    expect(urls(splitByUrl('www.example.com'))).toEqual([]);
    expect(urls(splitByUrl('お問い合わせ: support@example.com'))).toEqual([]);
  });

  it('http という単語だけ・スキームのみでは誤検知しない', () => {
    expect(urls(splitByUrl('http という略語'))).toEqual([]);
    expect(urls(splitByUrl('https:// だけ'))).toEqual([]);
  });

  it('改行を挟んだ複数 URL も個別に検出', () => {
    const segs = splitByUrl('https://a.example.com\nhttps://b.example.com');
    expect(urls(segs)).toEqual(['https://a.example.com', 'https://b.example.com']);
    expect(joined(segs)).toBe('https://a.example.com\nhttps://b.example.com');
  });

  it('どんな入力でも連結すると元テキストに復元できる (情報欠落なし)', () => {
    const samples = [
      'https://tasukiba.com/loginにアクセス。',
      'なにもなし',
      'a https://x.com b https://y.com。',
      '（https://z.example.com/path?q=1）です',
    ];
    for (const s of samples) {
      expect(joined(splitByUrl(s))).toBe(s);
    }
  });
});

describe('containsUrl', () => {
  it('http/https を含めば true', () => {
    expect(containsUrl('見てね https://example.com')).toBe(true);
    expect(containsUrl('http://example.com')).toBe(true);
  });
  it('URL が無ければ false', () => {
    expect(containsUrl('')).toBe(false);
    expect(containsUrl('普通の文章 www.example.com')).toBe(false);
  });
});
