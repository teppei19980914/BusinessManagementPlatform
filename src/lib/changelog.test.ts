import { describe, expect, it } from 'vitest';
import { parseChangelog } from './changelog';

/**
 * CHANGELOG.md パーサの単体テスト (I/O 分離した parseChangelog のみカバー)。
 * 実ファイル読み出し (loadChangelog) は環境依存のため integration 領域に委ね、
 * ここでは「形式が守られていれば構造化される」「逸脱を吸収する」を検証する。
 */

describe('parseChangelog', () => {
  it('基本フォーマット (## [version] — date) を分割できる', () => {
    const raw = [
      '# 更新履歴',
      '',
      '導入文。',
      '',
      '## [1.1.0] — 2026-07-01',
      '',
      '7 月リリース。',
      '',
      '### 追加',
      '- 機能 A',
      '',
      '## [1.0.0] — 2026-06-01',
      '',
      'GA リリース。',
    ].join('\n');

    const entries = parseChangelog(raw);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ version: '1.1.0', date: '2026-07-01' });
    expect(entries[0].body).toContain('機能 A');
    expect(entries[1]).toMatchObject({ version: '1.0.0', date: '2026-06-01' });
    expect(entries[1].body).toContain('GA リリース');
  });

  it('日付が無いバージョンは date=null になる', () => {
    const raw = ['## [2.0.0-beta.1]', '', 'プレビューリリース。'].join('\n');
    const entries = parseChangelog(raw);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ version: '2.0.0-beta.1', date: null });
  });

  it('日付が ISO-8601 形式でなければ date=null にフォールバック', () => {
    const raw = ['## [1.0.0] — 2026/06/01', '', '内容'].join('\n');
    const entries = parseChangelog(raw);
    expect(entries[0].date).toBeNull();
  });

  it('バージョン見出しが 1 つも無ければ空配列を返す', () => {
    const raw = [
      '# 更新履歴',
      '',
      '導入文だけのファイル。',
      '',
      '## カテゴリ',
      '- a',
    ].join('\n');
    expect(parseChangelog(raw)).toEqual([]);
  });

  it('CRLF 改行も処理できる (Windows で生成された CHANGELOG への耐性)', () => {
    const raw = ['## [1.0.0] — 2026-06-01', '', 'GA'].join('\r\n');
    const entries = parseChangelog(raw);
    expect(entries).toHaveLength(1);
    expect(entries[0].body).toBe('GA');
  });

  it('body の前後空白はトリムする', () => {
    const raw = ['## [1.0.0] — 2026-06-01', '', '', '中身', '', ''].join('\n');
    expect(parseChangelog(raw)[0].body).toBe('中身');
  });
});
