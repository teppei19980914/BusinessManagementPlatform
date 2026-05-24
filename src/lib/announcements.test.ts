import { describe, expect, it } from 'vitest';
import {
  isSafeAnnouncementSlug,
  parseAnnouncementFilename,
  parseFrontmatter,
} from './announcements';

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

/**
 * CodeQL stored XSS 対策で導入した slug boundary validation のテスト。
 * filesystem 由来文字列が URL に到達する手前で「英数+ハイフンのみ」に厳密化する。
 */
describe('isSafeAnnouncementSlug', () => {
  it('英数 + ハイフン のみで構成される slug は true', () => {
    expect(isSafeAnnouncementSlug('launch')).toBe(true);
    expect(isSafeAnnouncementSlug('2026-06-01-launch')).toBe(true);
    expect(isSafeAnnouncementSlug('a-b-c-1-2-3')).toBe(true);
    expect(isSafeAnnouncementSlug('abc123')).toBe(true);
  });

  it('空文字 / 制御文字 / unicode / 大文字 / 特殊記号は false (= stored XSS 防御)', () => {
    expect(isSafeAnnouncementSlug('')).toBe(false);
    expect(isSafeAnnouncementSlug('Launch')).toBe(false); // 大文字
    expect(isSafeAnnouncementSlug('リリース')).toBe(false); // 全角
    expect(isSafeAnnouncementSlug('launch/../etc')).toBe(false); // path traversal
    expect(isSafeAnnouncementSlug('launch?x=1')).toBe(false); // query
    expect(isSafeAnnouncementSlug('launch#frag')).toBe(false); // fragment
    expect(isSafeAnnouncementSlug('javascript:alert(1)')).toBe(false); // pseudo-protocol
    expect(isSafeAnnouncementSlug('a b')).toBe(false); // 空白
    expect(isSafeAnnouncementSlug('a\nb')).toBe(false); // 改行
    expect(isSafeAnnouncementSlug('a.b')).toBe(false); // ドット
  });
});

/**
 * PR #433 の E2E fail を引き起こした「FILENAME_PATTERN regex で match[2] が
 * 日付の後ろ部分のみ抜き出してしまい、URL slug 設計と乖離するバグ」の回帰テスト。
 *
 * 期待挙動: ファイル名全体 (.md 除く) を slug として返す。
 *   `2026-06-01-launch.md` → slug=`2026-06-01-launch`, date=`2026-06-01`
 *
 * このテストが存在することで、今後 regex を変更した際に
 * 「ファイル名 = slug」原則が誤って壊れるのを単体テストで catch できる。
 */
describe('parseAnnouncementFilename', () => {
  it('YYYY-MM-DD-{slug}.md の slug は **全体** (例: 2026-06-01-launch)', () => {
    // ★最重要★ slug は filename 全体から `.md` を除いたもの。
    // 旧版 (PR #433 初版) は slug='launch' を返す regex バグで E2E が fail した。
    expect(parseAnnouncementFilename('2026-06-01-launch.md')).toEqual({
      slug: '2026-06-01-launch',
      date: '2026-06-01',
    });
  });

  it('複数ハイフン区切りの slug 部分も正しく取り込む', () => {
    expect(parseAnnouncementFilename('2026-12-31-year-end-notice.md')).toEqual({
      slug: '2026-12-31-year-end-notice',
      date: '2026-12-31',
    });
  });

  it('数字のみの slug 部分も OK (例: 2026-06-01-001)', () => {
    expect(parseAnnouncementFilename('2026-06-01-001.md')).toEqual({
      slug: '2026-06-01-001',
      date: '2026-06-01',
    });
  });

  it('形式に合わないファイル名は null', () => {
    // 日付欠落
    expect(parseAnnouncementFilename('launch.md')).toBeNull();
    // 拡張子違い
    expect(parseAnnouncementFilename('2026-06-01-launch.txt')).toBeNull();
    // 大文字含む (CodeQL boundary validation が弾く)
    expect(parseAnnouncementFilename('2026-06-01-Launch.md')).toBeNull();
    // 全角文字
    expect(parseAnnouncementFilename('2026-06-01-リリース.md')).toBeNull();
    // path traversal
    expect(parseAnnouncementFilename('../etc/passwd')).toBeNull();
  });

  // 注: 日付の値妥当性 (例: 月が 13) は parseAnnouncementFilename の責務外。
  //   regex は「YYYY-MM-DD 形式」を見るのみ。実カレンダー上の妥当性は
  //   別レイヤ (frontmatter の publishedAt validation) で担当。
});
