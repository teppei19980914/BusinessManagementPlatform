/**
 * アプリバージョン / リリース日のアクセサ (feat/app-version-changelog-footer / 2026-05-23)。
 *
 * 真値は build 時に next.config.ts で `package.json` から読み出され
 * `NEXT_PUBLIC_APP_VERSION` / `NEXT_PUBLIC_RELEASE_DATE` として client bundle に注入される。
 * 本ファイルはその参照ヘルパで、未注入時の fallback と日付整形を担う。
 *
 * 既存設定との関係:
 *   - `package.json.version` が真値 (SemVer: MAJOR.MINOR.PATCH)
 *   - リリース日は環境変数 `NEXT_PUBLIC_RELEASE_DATE` で build 時上書き可、未設定時は 2026-06-01
 *   - 日付整形は next-intl の `useFormatter()` ではなく decoupled (server/client 共通利用のため)
 */

/** SemVer 互換のフォールバック既定値 (env 未注入時の安全側). */
const FALLBACK_VERSION = '0.0.0-dev';
const FALLBACK_RELEASE_DATE = '2026-06-01';

/**
 * アプリの現在バージョン (SemVer)。
 * 例: '1.0.0' / '1.2.3-beta.4'
 *
 * 取得経路: build 時 `next.config.ts` の `env.NEXT_PUBLIC_APP_VERSION` 経由で
 * `package.json.version` がインライン化されている。
 */
export function getAppVersion(): string {
  const v = process.env.NEXT_PUBLIC_APP_VERSION;
  return v && v.length > 0 ? v : FALLBACK_VERSION;
}

/**
 * リリース日 (ISO-8601 / `YYYY-MM-DD` 形式)。
 * 例: '2026-06-01'
 *
 * 取得経路: build 時 `next.config.ts` の `env.NEXT_PUBLIC_RELEASE_DATE`。
 * 環境変数で上書き可能 (将来のマイナーリリースで日付更新)。
 */
export function getReleaseDate(): string {
  const d = process.env.NEXT_PUBLIC_RELEASE_DATE;
  if (!d || d.length === 0) return FALLBACK_RELEASE_DATE;
  // ISO-8601 日付形式 (YYYY-MM-DD) であることを軽くガード。誤値が build に紛れた場合の防御。
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : FALLBACK_RELEASE_DATE;
}

/**
 * フッタ等で人間向け表示するバージョン文字列。
 * 例: 'v1.0.0 (2026-06-01)'
 */
export function formatVersionLabel(): string {
  return `v${getAppVersion()} (${getReleaseDate()})`;
}
