# 環境変数一覧 — 移転しました (2026-05-30)

> 🔀 **このドキュメントは [docs/design/ENVIRONMENT_VARIABLES.md](../design/ENVIRONMENT_VARIABLES.md) に統合・移転しました。**
>
> 環境変数の正(as-built インベントリ + 取得方法・運用注意・Netlify deploy context マトリクス)は
> **[docs/design/ENVIRONMENT_VARIABLES.md](../design/ENVIRONMENT_VARIABLES.md)** を参照してください。
>
> 旧 `docs/operations/ENV_VARS.md` の全文は **[docs/archive/ENV_VARS.md](../archive/ENV_VARS.md)** に凍結保存しています(過去の経緯参照用)。
>
> 二重管理防止のため、本ファイルはリダイレクト用の tombstone です(既存リンク互換のため残置)。

## 主要セクション (移転先)
- 変数インベントリ (値 / context / scope): ENVIRONMENT_VARIABLES.md §1〜§9
- 気になる点・改善余地: §10
- 取得方法・運用注意 (`NEXTAUTH_SECRET` ローテーション時の MFA 復号不能注意 等)・プロバイダ参考値: §11
- Deploy context 別設定マトリクス + Netlify 設定手順/CLI: §12
- ローカル専用・その他の変数: §13

関連: [STRIPE_ENV_MAPPING.md](../design/STRIPE_ENV_MAPPING.md) / [STRIPE_SETUP.md](./STRIPE_SETUP.md) / [DEPLOYMENT.md](./DEPLOYMENT.md)
