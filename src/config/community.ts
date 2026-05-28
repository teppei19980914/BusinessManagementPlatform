/**
 * コミュニティ関連リンク (#16 / 2026-05-09)。
 *
 * Discord 招待リンクなど「ユーザに案内したい外部 URL」をここで一元管理する。
 * デプロイ環境ごとにリンク先が変わる可能性があるため `NEXT_PUBLIC_*` 環境変数で上書き可能。
 *
 * UI 側は `getDiscordInviteUrl()` を呼び、null の場合はボタン自体を描画しない。
 *
 * 2026-05-09 (PR I): ヘルプ画面追加に伴い、機能要望・案件依頼用の専用リンクを分離可能化。
 *   - `getFeatureRequestUrl()` が null を返す場合は一般 Discord (= getDiscordInviteUrl) にフォールバック
 *   - 専用フォーラムチャンネルを切り出したい運営は NEXT_PUBLIC_FEATURE_REQUEST_URL を設定
 *
 * LP (HomePage) URL は固定 (本サービスのプロダクトページ)。i18n / 環境別のロケール切替が
 * 発生したら本ファイルで関数化する想定。現時点は ja のみのため定数で十分。
 */

/**
 * 公開済 Discord 招待リンク (本サービス公式)。
 *
 * 2026-05-09 (PR I): ユーザ提供の正式コミュニティ URL を **既定値** として埋め込む。
 *   - 招待 URL はクライアントに見える前提なので公開して問題ない (機密ではない)。
 *   - 環境変数 `NEXT_PUBLIC_DISCORD_INVITE_URL` が設定されていればそちらが優先される
 *     (招待 URL を切り替えるとき / 別環境で異なるサーバを使うときの上書き手段)。
 *   - 万一定数を空文字 / "disabled" に書き換えれば UI はボタン非表示にフォールバック。
 */
export const DEFAULT_DISCORD_INVITE_URL = 'https://discord.com/invite/EqY82YvxuG';

/**
 * Discord 招待リンクを返す。env 上書きがあればそれを、なければ {@link DEFAULT_DISCORD_INVITE_URL} を返す。
 * 既定値も空文字 / "disabled" の場合は null (= ボタン非表示) にフォールバック。
 *
 * `NEXT_PUBLIC_*` プレフィックスを付けることで Next.js のクライアントバンドルに
 * 埋め込まれる (server / client 両方から参照可能)。
 */
export function getDiscordInviteUrl(): string | null {
  const env = process.env.NEXT_PUBLIC_DISCORD_INVITE_URL;
  const url = env && env.trim().length > 0 ? env : DEFAULT_DISCORD_INVITE_URL;
  if (!url || url.trim().length === 0 || url === 'disabled') return null;
  return url;
}

/**
 * 機能要望・案件依頼用のリンク (Discord フォーラムチャンネル / 別 URL)。
 * 未設定の場合は null を返し、UI は一般 Discord リンクで代替する。
 */
export function getFeatureRequestUrl(): string | null {
  const url = process.env.NEXT_PUBLIC_FEATURE_REQUEST_URL;
  if (!url || url.trim().length === 0) return null;
  return url;
}

/**
 * プロダクト LP (HomePage) の URL。
 * 「使い方」ページや CTA に表示する公開ページ。
 * 一般 Discord と異なり常時公開のため定数で管理。
 */
export const PRODUCT_LP_URL = 'https://teppei19980914.github.io/HomePage/ja/product/tasukiba/';

/**
 * テナント管理者向け「初回ログイン手順ガイド」ページ (HomePage) の URL。
 *
 * 2026-05-28 (feat/login-setup-guide-link / KDD §5.X+168) で集約。
 * ログイン画面フッタとそれを検証する smoke spec で同 literal が並列して書かれていたため、
 * URL 変更時の片側更新漏れによる drift を防ぐ目的で本ファイルに集約。
 *
 * 利用箇所:
 *   - `src/app/(auth)/login/page.tsx` フッタの「セットアップガイド」リンク
 *   - `e2e/specs/00-smoke.spec.ts` のリンク href assertion
 *
 * 変更時の影響: 上記 2 箇所は必ず本定数経由で参照する。直 literal 化を見つけたら本定数に差し戻す。
 */
export const SETUP_GUIDE_URL = 'https://teppei19980914.github.io/HomePage/ja/product/tasukiba-setup-guide/';
