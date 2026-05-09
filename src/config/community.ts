/**
 * コミュニティ関連リンク (#16 / 2026-05-09)。
 *
 * Discord 招待リンクなど「ユーザに案内したい外部 URL」をここで一元管理する。
 * デプロイ環境ごとにリンク先が変わる可能性があるため `NEXT_PUBLIC_*` 環境変数で上書き可能。
 *
 * UI 側は `getDiscordInviteUrl()` を呼び、null の場合はボタン自体を描画しない。
 */

/**
 * Discord 招待リンク。`NEXT_PUBLIC_DISCORD_INVITE_URL` が設定されていればその値、
 * 未設定または空文字なら null を返す (UI はこの場合ボタンを非表示にする)。
 *
 * `NEXT_PUBLIC_*` プレフィックスを付けることで Next.js のクライアントバンドルに
 * 埋め込まれる (server / client 両方から参照可能)。
 */
export function getDiscordInviteUrl(): string | null {
  const url = process.env.NEXT_PUBLIC_DISCORD_INVITE_URL;
  if (!url || url.trim().length === 0) return null;
  return url;
}
