/**
 * CHANGELOG.md パーサ (feat/app-version-changelog-footer / 2026-05-23)。
 *
 * 真値は repository root の `CHANGELOG.md` (Keep a Changelog 形式)。
 * 本モジュールは build 時 / Server Component から `fs.readFileSync` で読み出し、
 * バージョン別に分割した構造化データを返す。
 *
 * 想定形式 (各 entry を `## [version] — YYYY-MM-DD` の見出しで区切る):
 *
 *   ```
 *   ## [1.0.0] — 2026-06-01
 *
 *   GA リリース。
 *
 *   ### 追加
 *   - ...
 *   ```
 *
 * フォーマット逸脱への耐性:
 *   - 見出しに `[version]` が無ければ `version=null` で無視する (= ファイル先頭の
 *     intro 見出し等を取り違えない)
 *   - 日付が ISO-8601 でなければ `date=null` (UI 側で「日付未設定」表示にフォールバック)
 *
 * **注意**: Edge runtime では `fs` を呼べない。本モジュールは
 *   - Server Component (RSC) の page.tsx から呼ぶ
 *   - もしくは Build-time の Static page で消費する
 *   いずれかの用途に限定する。Client Component から呼ばない。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface ChangelogEntry {
  /** SemVer (例: "1.0.0") */
  version: string;
  /** ISO-8601 日付 (例: "2026-06-01")。フォーマット逸脱時は null */
  date: string | null;
  /** バージョン見出し直下の markdown 本文 (次の `## ` または EOF まで) */
  body: string;
}

const CHANGELOG_PATH = resolve(process.cwd(), 'CHANGELOG.md');

/**
 * `## [1.2.3] — 2026-06-01` を捕捉。日付前は em-dash / hyphen / 中黒のいずれでも許容。
 * 日付部は緩めにマッチ (`\S+`) し、ISO-8601 (YYYY-MM-DD) 形式の判定はコード側で行う。
 * こうしないと `2026/06/01` 等の誤フォーマットを書いた行で全マッチが失敗し、
 * エントリ自体が消えてしまう (= 「フォーマット逸脱でも version だけは残す」を担保)。
 *
 * 注: tsconfig.json `target: ES2017` のため named capture group は使えず、
 * positional group ([1]=version, [2]=date) で運用する。
 */
const HEADING_PATTERN =
  /^##\s+\[([^\]]+)\]\s*(?:[—\-·]\s*(\S+))?\s*$/;

/**
 * CHANGELOG.md を読み出し、バージョン単位に分割した配列を返す。
 * 新しい順 (= ファイル上から下の順) で並ぶ。
 *
 * 取得失敗 (ENOENT 等) は空配列を返す。本機能は補助的な表示なので、
 * ファイル欠落でアプリ全体を落とさない (空 state を UI 側で表示)。
 */
export function loadChangelog(): ChangelogEntry[] {
  let raw: string;
  try {
    raw = readFileSync(CHANGELOG_PATH, 'utf-8');
  } catch {
    return [];
  }
  return parseChangelog(raw);
}

/**
 * CHANGELOG.md のテキスト本体をパースする (テスト容易化のため I/O を分離)。
 */
export function parseChangelog(raw: string): ChangelogEntry[] {
  const lines = raw.split(/\r?\n/);
  const entries: ChangelogEntry[] = [];

  let current: { version: string; date: string | null; bodyLines: string[] } | null = null;

  for (const line of lines) {
    const headingMatch = HEADING_PATTERN.exec(line);
    if (headingMatch) {
      // 既存 entry を確定
      if (current) {
        entries.push({
          version: current.version,
          date: current.date,
          body: current.bodyLines.join('\n').trim(),
        });
      }
      const rawDate = headingMatch[2] ?? null;
      const date = rawDate && /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : null;
      current = {
        version: headingMatch[1],
        date,
        bodyLines: [],
      };
      continue;
    }
    if (current) {
      current.bodyLines.push(line);
    }
  }
  if (current) {
    entries.push({
      version: current.version,
      date: current.date,
      body: current.bodyLines.join('\n').trim(),
    });
  }

  return entries;
}

/** 最新 1 件 (= 配列先頭) を返す。空なら null. */
export function getLatestChangelogEntry(): ChangelogEntry | null {
  const entries = loadChangelog();
  return entries[0] ?? null;
}
