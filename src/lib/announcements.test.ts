import { describe, expect, it } from 'vitest';
import { parseFrontmatter } from './announcements';

/**
 * Announcement frontmatter パーサの単体テスト。
 * loadAnnouncements() は fs I/O を伴うため別途 integration 検証。
 */

describe('parseFrontmatter', () => {
  it('frontmatter があれば data と body に分割できる', () => {
    const raw = [
      '---',
      'title: GA リリース',
      'publishedAt: 2026-06-01',
      'severity: info',
      '---',
      '',
      '## 本文',
      'たすきば Knowledge Relay v1.0 をリリースしました。',
    ].join('\n');
    const { data, body } = parseFrontmatter(raw);
    expect(data).toMatchObject({
      title: 'GA リリース',
      publishedAt: '2026-06-01',
      severity: 'info',
    });
    expect(body).toContain('## 本文');
    expect(body).toContain('たすきば Knowledge Relay');
  });

  it('値の前後の引用符は剥がす (single / double 両方)', () => {
    const raw = [
      '---',
      'title: "クォート付き タイトル"',
      "summary: 'シングルクォート要約'",
      '---',
      '本文',
    ].join('\n');
    const { data } = parseFrontmatter(raw);
    expect(data.title).toBe('クォート付き タイトル');
    expect(data.summary).toBe('シングルクォート要約');
  });

  it('frontmatter が無いファイルは data 空 + body=raw として返す', () => {
    const raw = '## 見出しから始まるファイル\n本文';
    const { data, body } = parseFrontmatter(raw);
    expect(data).toEqual({});
    expect(body).toBe(raw);
  });

  it('CRLF 改行のフロントマターも処理できる', () => {
    const raw = [
      '---',
      'title: タイトル',
      'publishedAt: 2026-06-01',
      '---',
      '本文',
    ].join('\r\n');
    const { data } = parseFrontmatter(raw);
    expect(data.title).toBe('タイトル');
    expect(data.publishedAt).toBe('2026-06-01');
  });

  it('不正な行 (key 無し / コロン無し) は無視する', () => {
    const raw = [
      '---',
      'title: 正常',
      'これは不正な行',
      ': value-only',
      'publishedAt: 2026-06-01',
      '---',
      '本文',
    ].join('\n');
    const { data } = parseFrontmatter(raw);
    expect(data).toEqual({ title: '正常', publishedAt: '2026-06-01' });
  });
});
