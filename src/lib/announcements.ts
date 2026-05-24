/**
 * お知らせ機能のローダ (feat/app-version-changelog-footer / 2026-05-23)。
 *
 * 真値: `docs/public/announcements/{YYYY-MM-DD}-{slug}.md` (frontmatter 駆動)。
 * DB schema は追加せず markdown ファイルを真値とすることで、運用は git PR で完結する。
 *
 * frontmatter 仕様:
 *
 *   ```
 *   ---
 *   title: 一般提供を開始しました
 *   publishedAt: 2026-06-01
 *   severity: info
 *   summary: たすきば Knowledge Relay v1.0 をリリースしました。
 *   ---
 *
 *   ## 本文 (markdown)
 *   ```
 *
 * - `title`: お知らせのタイトル (必須)
 * - `publishedAt`: 公開日 (YYYY-MM-DD、必須)
 * - `severity`: `info` (既定) / `warning` / `critical` / `maintenance`
 * - `summary`: 一覧表示用の短い要約 (任意)
 *
 * **注意**: Edge runtime では `fs` を呼べない。本モジュールは Server Component または
 * build-time 利用に限定する。
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export type AnnouncementSeverity = 'info' | 'warning' | 'critical' | 'maintenance';

export interface AnnouncementMeta {
  slug: string;
  title: string;
  /** ISO-8601 (YYYY-MM-DD). frontmatter になければファイル名先頭から推定 */
  publishedAt: string;
  severity: AnnouncementSeverity;
  summary: string;
}

export interface Announcement extends AnnouncementMeta {
  /** frontmatter 除去後の markdown 本文 */
  body: string;
}

const ANNOUNCEMENTS_DIR = resolve(process.cwd(), 'docs/public/announcements');

/**
 * ファイル名から slug (= 拡張子を除いた全体) と日付を抽出。
 *
 * 例: `2026-06-01-launch.md` → slug=`2026-06-01-launch`, date=`2026-06-01`
 *
 * 設計判断:
 *   - URL は `/announcements/2026-06-01-launch` の形になることを期待 (人間が読んで
 *     公開日と内容を一目で判別可能なため)。**slug = ファイル名全体 (拡張子除く)** が原則。
 *   - 日付は frontmatter `publishedAt` が真値だが、書き忘れに備え filename 先頭からも抽出。
 *
 * tsconfig.json `target: ES2017` 制約により positional group を使用:
 *   - match[1] = 全 slug ("2026-06-01-launch")
 *   - match[2] = 日付部分のみ ("2026-06-01")
 *
 * 注意: 旧版 (2026-05-23 初版) は `/^(\d{4}-\d{2}-\d{2})-([a-z0-9-]+)\.md$/` で
 *   match[2] が「日付の後ろ」(= "launch") になり、URL 設計と乖離する重大バグだった (PR #433 E2E fail で発覚)。
 *   新版は外側 group で全 slug を捕捉する。
 */
const FILENAME_PATTERN = /^((\d{4}-\d{2}-\d{2})-[a-z0-9-]+)\.md$/;

/**
 * slug が URL safe な英数 + ハイフンのみであることを明示的に validate する。
 * CodeQL の taint 分析は regex.exec の capture group の制約を追跡しないため、
 * 「filesystem 由来 → URL 文字列」のチェーンを stored XSS と誤検出する。
 * 本関数で boundary を sanitizer として明示し、taint flow を遮断する。
 *
 * 設計上 FILENAME_PATTERN の `[a-z0-9-]+` capture と同じ制約。
 * `^[a-z0-9-]+$` 厳密一致のみ true (空文字 / .. / 制御文字 / unicode はすべて拒否)。
 */
export function isSafeAnnouncementSlug(s: string): boolean {
  return /^[a-z0-9-]+$/.test(s);
}

/**
 * ファイル名 (例: `2026-06-01-launch.md`) から slug と日付を抽出する。
 * 形式に一致しない / slug が unsafe (`isSafeAnnouncementSlug` 不合格) なら null.
 *
 * 切り出した理由:
 *   - 純関数なので I/O モックなしでテスト可能
 *   - PR #433 で `match[2]` が「日付の後ろ部分」になる regex バグを起こし
 *     E2E でしか検出できなかったため、回帰テスト容易化のため独立関数化
 */
export function parseAnnouncementFilename(
  filename: string,
): { slug: string; date: string } | null {
  const match = FILENAME_PATTERN.exec(filename);
  if (!match) return null;
  const slug = match[1];
  const date = match[2];
  if (!isSafeAnnouncementSlug(slug)) return null;
  return { slug, date };
}

/**
 * frontmatter `---` 〜 `---` を切り出し、key:value をパースする。
 * 軽量パーサ (依存追加を避けるため YAML 全部はサポートしない)。
 * 仕様: 文字列 (引用符任意) / 単一行のみ。複数行値は未サポート。
 */
export function parseFrontmatter(raw: string): {
  data: Record<string, string>;
  body: string;
} {
  // 先頭が `---\n` で始まらなければ frontmatter なし
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!match) {
    return { data: {}, body: raw };
  }
  const data: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*?)\s*$/.exec(line);
    if (!kv) continue;
    let value = kv[2];
    // 前後の引用符を剥がす (シングル / ダブル)
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    data[kv[1]] = value;
  }
  return { data, body: match[2] };
}

/** severity の値を型安全に正規化する */
function normalizeSeverity(s: string | undefined): AnnouncementSeverity {
  if (s === 'warning' || s === 'critical' || s === 'maintenance') return s;
  return 'info';
}

/**
 * announcements ディレクトリを走査し、frontmatter + 本文を読み出した配列を
 * 公開日の降順 (新しい順) で返す。
 *
 * ディレクトリ自体が存在しない場合は空配列を返す (= ファイル欠落で全体を落とさない)。
 */
export function loadAnnouncements(): Announcement[] {
  let entries: string[];
  try {
    entries = readdirSync(ANNOUNCEMENTS_DIR);
  } catch {
    return [];
  }

  const announcements: Announcement[] = [];
  for (const filename of entries) {
    const parsed = parseAnnouncementFilename(filename);
    if (!parsed) continue;
    const { slug: filenameSlug, date: filenameDate } = parsed;
    const fullPath = join(ANNOUNCEMENTS_DIR, filename);
    // CodeQL TOCTOU 対策: statSync の事前チェックは race condition を生むため
    //   readFileSync を直接呼び、ディレクトリ / 不在 / 権限不足のいずれも try/catch で一括処理する。
    try {
      const raw = readFileSync(fullPath, 'utf-8');
      const { data, body } = parseFrontmatter(raw);
      const publishedAt =
        data.publishedAt && /^\d{4}-\d{2}-\d{2}$/.test(data.publishedAt)
          ? data.publishedAt
          : filenameDate;
      announcements.push({
        slug: filenameSlug,
        title: data.title ?? filenameSlug,
        publishedAt,
        severity: normalizeSeverity(data.severity),
        summary: data.summary ?? '',
        body: body.trim(),
      });
    } catch {
      // ディレクトリだった / シンボリックリンクが切れた / 読込権限なし 等は個別 skip
      // (全体を止めない、欠落は UI 側で「該当 slug なし」として現れる)
      continue;
    }
  }
  // publishedAt の降順、同日内は slug 昇順で安定ソート
  announcements.sort((a, b) => {
    if (a.publishedAt !== b.publishedAt) {
      return a.publishedAt < b.publishedAt ? 1 : -1;
    }
    return a.slug < b.slug ? -1 : 1;
  });
  return announcements;
}

/** slug を指定して 1 件取得。見つからなければ null */
export function getAnnouncement(slug: string): Announcement | null {
  return loadAnnouncements().find((a) => a.slug === slug) ?? null;
}

/** 一覧用 meta だけ取得 (本文の重さを避けたい場合) */
export function loadAnnouncementMetas(): AnnouncementMeta[] {
  return loadAnnouncements().map((a) => ({
    slug: a.slug,
    title: a.title,
    publishedAt: a.publishedAt,
    severity: a.severity,
    summary: a.summary,
  }));
}

/** 最新 1 件を取得 (バナー表示用)。空なら null */
export function getLatestAnnouncement(): Announcement | null {
  return loadAnnouncements()[0] ?? null;
}
