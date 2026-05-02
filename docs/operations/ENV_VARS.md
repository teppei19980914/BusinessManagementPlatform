# 環境変数一覧 (Operations)

本ドキュメントは、本サービスの全環境変数を一覧化する (OPERATION.md §1 を転記)。デプロイ手順は [DEPLOYMENT.md](./DEPLOYMENT.md)、ローカル起動は [SETUP_LOCAL.md](./SETUP_LOCAL.md) を参照。

---

## 1. 環境変数一覧

`.env.example` に定義されている全変数。ローカル開発は `cp .env.example .env` して編集する。本番 (Vercel) は Vercel ダッシュボードの Project Settings → Environment Variables に設定する。

### 1.1 ポート設定

| 変数名 | 既定値 | 用途 | 取得方法 |
|---|---|---|---|
| `APP_PORT` | `3000` | Next.js 開発サーバが待ち受けるポート | 既存プロセスと衝突時のみ変更 |
| `DB_PORT` | `5433` | ローカル PostgreSQL (Docker) の公開ポート | 同上 (5432 は OS 既存 PG と衝突しやすいため既定で 5433) |

### 1.2 データベース

| 変数名 | 例 | 用途 |
|---|---|---|
| `DB_NAME` | `tasukiba` | ローカル DB の DB 名 |
| `DB_USER` | `postgres` | ローカル DB のユーザ名 |
| `DB_PASSWORD` | `postgres` | ローカル DB のパスワード |
| `DATABASE_URL` | `postgresql://postgres:postgres@localhost:5433/tasukiba` (ローカル) / `postgresql://postgres.[ref]:[password]@aws-1-ap-northeast-1.pooler.supabase.com:6543/postgres?pgbouncer=true` (Supabase) | アプリが実行時に接続する DB。Supabase 利用時は **Pooler (ポート 6543)** を使う |
| `DIRECT_URL` | `postgresql://postgres:postgres@localhost:5433/tasukiba` (ローカル) / `postgresql://postgres:[password]@db.[ref].supabase.co:5432/postgres` (Supabase) | Prisma が migration で使う直結 URL。Supabase 利用時は `db.[ref].supabase.co:5432` |

> **なぜ 2 つ必要か**: Prisma の migration は lock を取るため pooler 経由だと動かない。アプリ実行は pooler 経由で接続数を抑える。

**Supabase の接続文字列取得方法** (要確認で検証)

1. Supabase ダッシュボードでプロジェクトを開く
2. **Project Settings → Database → Connection String** を開く
3. **Transaction mode (pooler)** の URI を `DATABASE_URL` に設定
4. **Session mode (direct)** の URI を `DIRECT_URL` に設定

### 1.3 アプリケーション

| 変数名 | 例 | 用途 | 取得方法 |
|---|---|---|---|
| `NEXTAUTH_URL` | `http://localhost:3000` (ローカル) / `https://tasukiba.vercel.app` (本番) | NextAuth がリダイレクト先の URL 解決に使う | アプリが公開される URL |
| `NEXTAUTH_SECRET` | (32 バイトのランダム文字列) | JWT の署名鍵 | ```openssl rand -base64 32``` で生成 |

> **ローテーション時の注意**: `NEXTAUTH_SECRET` を変更すると全ユーザのセッション JWT が即時無効化され、強制的に再ログインとなる。
>
> **セッション有効期限** (`src/config/security.ts` の `SESSION_JWT_MAX_AGE_SEC`): **9 時間**
>   (PR #124 で 24h→9h 短縮)。日本の通常就業時間 (8h + 休憩 1h) を超えて無操作なら強制ログアウト。
>   NextAuth JWT 戦略は各リクエストで token を再署名する sliding 挙動のため、実質「最後の操作から 9 時間」。

### 1.4 メール送信

| 変数名 | 値 | 用途 |
|---|---|---|
| `MAIL_PROVIDER` | `console` / `brevo` / `resend` / `inbox` | 送信方法の切替 (`console` は実送信せずコンソールへ出力、`inbox` は E2E 専用でファイル出力) |
| `MAIL_FROM` | `noreply@example.com` | 送信元アドレス (Brevo / Resend 共通) |
| `MAIL_FROM_NAME` | `たすきば` | 送信元表示名 (Brevo のみ使用) |
| `BREVO_API_KEY` | `xkeysib-xxxxx...` | Brevo API キー (`MAIL_PROVIDER=brevo` 時、**本番既定**)。取得: <https://app.brevo.com/settings/keys/api>。送信元アドレスは Brevo ダッシュボードで事前検証必須 |
| `RESEND_API_KEY` | `re_xxxxx...` | Resend API キー (`MAIL_PROVIDER=resend` 時、代替選択肢)。取得: <https://resend.com/api-keys>。ドメイン未検証時はオーナーメール以外に送信不可 |
| `INBOX_DIR` | `/tmp/tasukiba-e2e-inbox` | 送信内容の JSON 書き出し先 (`MAIL_PROVIDER=inbox` 時、E2E 専用、本番では使わない) |

> **本番推奨**: `brevo` (無料 300 通/日、`.env.example` で ★推奨 明示)
>
> **注**: 過去ドキュメントに `MAIL_PROVIDER=smtp` + `SMTP_HOST/PORT/USER/PASS` の記載があったが、
> 現行コードの `createMailProvider()` (`src/lib/mail/index.ts`) は `smtp` ケースを持たない。
> 指定した場合 `default` 分岐で `console` にフォールバックする (横展開漏れのため PR #123 で docs から削除)。

### 1.5 初期管理者 (シード用)

| 変数名 | 値 | 用途 |
|---|---|---|
| `INITIAL_ADMIN_EMAIL` | `admin@example.com` | `pnpm db:seed` で作成する初期管理者のメール |
| `INITIAL_ADMIN_PASSWORD` | **10 文字以上 + 英大文字・英小文字・数字・記号のうち 3 種以上** | 初期管理者のパスワード。初回ログイン時に強制変更 |

> パスワードポリシー検証は `prisma/seed.ts` で実施している (`./prisma/seed.ts:36-45`)。条件を満たさないと seed が失敗する。

### 1.6 その他

| 変数名 | 既定値 | 用途 |
|---|---|---|
| `SEARCH_PROVIDER` | `pg_trgm` | 全文検索プロバイダ切替 (現状 pg_trgm のみ実装、要確認) |
| `ENABLE_OPERATION_TRACE` | `false` | 操作トレースの有効化フラグ (要確認: 詳細は DESIGN.md) |
| `CRON_SECRET` | (任意のランダム文字列) | Vercel Cron から `/api/admin/users/lock-inactive` 等を叩く際の `Authorization: Bearer` で使用。**未設定の場合 cron は実行されない** (手動実行は admin ログインで可能)。PR #89 で 30 日非アクティブユーザに使用 (feat/account-lock 改修で **論理削除 → ロック (isActive=false)** に方針変更)。 |

### 1.7 i18n (タイムゾーン / ロケール既定値) — PR #118 追加

| 変数名 | 既定値 (未設定時) | 用途 |
|---|---|---|
| `APP_DEFAULT_TIMEZONE` | `Asia/Tokyo` | システム全体のデフォルトタイムゾーン (IANA 名)。ユーザ個別設定 (`User.timezone`) が未設定の全ユーザに適用される。オンプレミス / クラウド拠点ごとに設定する想定 (例: `America/New_York`, `Europe/London`, `UTC`)。 |
| `APP_DEFAULT_LOCALE` | `ja-JP` | システム全体のデフォルトロケール (BCP 47)。対応は `src/config/i18n.ts` の `SUPPORTED_LOCALES` を参照。新規ロケール追加には `src/i18n/messages/<locale>.json` (PR #120 予定) も必要。 |

**設計意図**: DB は常に UTC で格納し (`timestamptz`)、描画時にタイムゾーンを解決する方針。
3 段階フォールバック: **ユーザ個別設定 → システムデフォルト (env) → FALLBACK (config)**。

**設定例** (米国東部拠点でのオンプレ展開):

```bash
# .env.production
APP_DEFAULT_TIMEZONE=America/New_York
APP_DEFAULT_LOCALE=en-US
```

詳細は [developer/DEVELOPER_GUIDE.md §10.8](../developer/DEVELOPER_GUIDE.md#108-タイムゾーン--ロケールの-3-段階フォールバック-pr-118) 参照。

---

