# たすきば Knowledge Relay - 運用手順書 (OPERATION.md)

> 初めて本コードベースを触る人が **AI に頼らず一人で** 開発・デプロイ・運用・障害対応できることを目的とした、運用手順の唯一の真実。
>
> - 本書は **実ファイル (README.md / .env.example / prisma/migrations / .github/workflows / vercel.json / package.json)** から読み取れる事実のみ記載する。
> - 推測で補った箇所は「**要確認**」と明記する。実環境で検証のうえ、本書を更新すること。
> - 対象環境: Vercel (Hobby プラン) + Supabase (Free プラン)
> - 2026-04-20: 旧 `OPERATIONS.md` (複数形、監視・定期実行系) を本書に統合し、運用情報を一本化した。

---

## 目次

1. [環境変数一覧](#1-環境変数一覧)
2. [ローカル開発環境の起動手順](#2-ローカル開発環境の起動手順)
3. [DB マイグレーション手順](#3-db-マイグレーション手順)
4. [適用済みマイグレーション一覧](#4-適用済みマイグレーション一覧)
5. [Vercel デプロイ手順](#5-vercel-デプロイ手順)
6. [障害対応](#6-障害対応)
7. [ロールバック手順](#7-ロールバック手順)
8. [定期実行 (Cron) 構成](#8-定期実行-cron-構成)
9. [cron-job.org ウォームアップ設定手順](#9-cron-joborg-ウォームアップ設定手順)
10. [ヘルスチェックエンドポイント仕様](#10-ヘルスチェックエンドポイント仕様)
11. [死活監視](#11-死活監視)
12. [今後追加予定の運用項目](#12-今後追加予定の運用項目)
13. [セキュリティ運用](#13-セキュリティ運用-pr-122-で追加) (PR #122 追加)

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

## 2. ローカル開発環境の起動手順

### 2.1 前提条件 (README より)

- **Node.js 22 LTS**
- **pnpm**
- **Docker / Docker Compose** (ローカル PostgreSQL を立てる場合) または **Supabase アカウント**

### 2.2 初回セットアップ

```bash
# 1. リポジトリを clone
git clone <repository-url>
cd BusinessManagementPlatform

# 2. 依存パッケージをインストール
pnpm install

# 3. 環境変数を複製・編集
cp .env.example .env
#   → DATABASE_URL / DIRECT_URL / NEXTAUTH_SECRET / INITIAL_ADMIN_PASSWORD を設定

# 4. (Supabase ではなくローカル PostgreSQL を使う場合)
#    docker-compose.yml が同梱されているかは要確認。
#    同梱されていない場合は Supabase を使うか、手動で PostgreSQL を起動する。

# 5. Prisma Client の生成 + マイグレーション適用
npx prisma generate
npx prisma migrate dev
#   → prisma/migrations/ の全 SQL が DB に順次適用される (初回は全テーブル作成)

# 6. 初期管理者アカウントを作成
pnpm db:seed
#   → .env の INITIAL_ADMIN_EMAIL / INITIAL_ADMIN_PASSWORD で管理者を作成
#   → リカバリーコード 10 個が標準出力に表示される (二度と表示されないため控えておく)

# 7. 開発サーバを起動
pnpm dev
```

完了後、<http://localhost:3000> にアクセスしログイン。

> **なぜ `pnpm db:seed` が必要か**: `prisma/seed.ts:36-45` でパスワードポリシーを検証し、初期管理者を `systemRole='admin'` + `forcePasswordChange=true` で作成する。これを飛ばすと誰もログインできない。

### 2.3 2 回目以降の起動

既に `pnpm install` と DB セットアップ済みの場合:

```bash
# 1. 最新コードに更新
git pull

# 2. 新規パッケージがあれば反映
pnpm install

# 3. 新規マイグレーションがあれば適用
npx prisma migrate dev
#   → 既に適用済みのマイグレーションはスキップされる (冪等)

# 4. Prisma Client が古い場合は再生成 (schema.prisma 変更時)
npx prisma generate

# 5. 開発サーバ起動
pnpm dev
```

> **tip**: `npx prisma migrate dev` は未適用のマイグレーションがあるかも同時に検出してくれる。

### 2.4 使えるその他コマンド (package.json より)

| コマンド | 内容 |
|---|---|
| `pnpm dev` | 開発サーバ起動 (Turbopack) |
| `pnpm build` | 本番ビルド (`next build`) |
| `pnpm start` | ビルド済みの本番サーバ起動 |
| `pnpm lint` | ESLint 実行 |
| `pnpm format` | Prettier で整形 |
| `pnpm format:check` | Prettier チェックのみ (CI 用) |
| `pnpm test` | Vitest 1 回実行 |
| `pnpm test:watch` | Vitest ウォッチモード |
| `pnpm db:seed` | 初期管理者作成 |
| `pnpm db:reset` | **DB を全削除して再作成** (⚠ 全データ消失、ローカルのみ) |
| `pnpm migrate:print <migration-name>` | マイグレーション SQL を標準出力 (Supabase SQL Editor 貼付用) |

---

## 3. DB マイグレーション手順

### 3.1 ローカル開発 DB への適用

```bash
# 未適用マイグレーションがあれば全て適用
npx prisma migrate dev

# 既存 DB を完全リセットしてゼロから適用したい場合 (⚠ 全データ消失)
pnpm db:reset
```

`prisma migrate dev` は `DIRECT_URL` を使って DB に直接接続しロックを取る。ローカルの PostgreSQL であれば問題なく動く。

### 3.2 新しいマイグレーションを作る (スキーマ変更時)

```bash
# 1. prisma/schema.prisma を編集

# 2. migration ファイルを生成 + ローカル DB に適用
npx prisma migrate dev --name <変更内容を英数字で>
#   → prisma/migrations/<timestamp>_<name>/migration.sql が生成される
#   → 同時にローカル DB にも適用される

# 3. Prisma Client を再生成 (通常 migrate dev が自動でやるが、念のため)
npx prisma generate
```

### 3.3 Supabase 本番への適用 (⚠ 手動)

**重要**: Vercel ビルドでは `prisma migrate deploy` を **実行していない**。理由 (README より):

> Vercel ビルド環境は IPv4 のみで Supabase の直結 URL `db.[ref].supabase.co:5432` に到達できない。

したがって本番への適用は **Supabase ダッシュボードの SQL Editor で手動** に実行する。

#### 手順

1. ローカルで SQL 本文を表示

   ```bash
   pnpm migrate:print <migration-name>
   # 例: pnpm migrate:print 20260420_user_theme_preference
   ```

   もしくは GitHub 上で `prisma/migrations/<name>/migration.sql` を開き、**Raw** ボタンから全文コピー。

2. Supabase ダッシュボードを開く → **SQL Editor** → 新規クエリ

3. コピーした **SQL テキスト全体** を貼り付け ( **ファイルパスを貼り付けない** )

   > ⚠ `prisma/migrations/.../migration.sql` とパスを貼ると `ERROR: 42601: syntax error at or near "prisma"` になる (README にも明記)。必ず中身の SQL テキストを貼る。

4. **Run** (または `Ctrl+Enter`) で実行

5. "Success. No rows returned" が表示されれば成功

6. **RLS 警告が出た場合**: **Run without RLS** を選択 (本プロジェクトは全テーブル RLS なし運用、既存テーブルと同方針)

### 3.4 自動化する場合 (README のメモより)

DIRECT_URL を **Supavisor セッションモード** (`pooler.supabase.com:5432`) に変更した上で、`vercel.json` の `buildCommand` に `pnpm prisma migrate deploy` を追加すれば Vercel 上で自動適用できる。ただし現状は採用されていない (要確認で実装検討)。

### 3.5 migration ファイルを後から修正した場合 (drift 対応、PR #90 で追加)

運用中に migration ファイルを編集した場合 (typo 修正 等)、本番 `_prisma_migrations` テーブルに記録されたチェックサムと乖離する。Prisma の `migrate deploy` は既に適用済みの migration を再実行しないが、`migrate status` / `migrate diff` で drift 警告が出る場合がある。

**drift 解消手順** (本番 DB に SSH/CLI 接続できる場合):

```bash
# 該当 migration を "適用済み" として再登録 (ハッシュ再計算)
pnpm prisma migrate resolve --applied <migration-name>
# 例: pnpm prisma migrate resolve --applied 20260418_visibility_and_risk_nature
```

**実例: PR #90 での `20260418_visibility_and_risk_nature` 修正**

- 元の migration: `UPDATE "knowledge"` (単数形 typo、fresh DB では `relation "knowledge" does not exist` で fail)
- 本番 DB: PR #62 の手順どおり SQL Editor で `UPDATE "knowledges"` を手動実行済 (DB 状態は正)
- `_prisma_migrations` テーブル: PR #60 当時のチェックサムで記録
- PR #90 で migration file を正しい `"knowledges"` に修正 → チェックサム変化
- 次回 `prisma migrate deploy` (もし自動化する場合) で drift 警告 → 上記 resolve コマンドで解消

---

## 4. 適用済みマイグレーション一覧

`prisma/migrations/` 配下の全マイグレーション (作成日時順)。各 SQL の先頭コメントを元に「一言で何を変えたか」を記載する。

| # | ディレクトリ名 | 変更内容 | 行数 |
|---|---|---|---|
| 1 | `20260415060313_init` | 初期スキーマ。users / sessions / recovery_codes / password_histories / projects / project_members / tasks / task_progress_logs / risks_issues / knowledges / knowledge_projects / task_knowledges / audit_logs / auth_event_logs / role_change_logs の **15 テーブル + 全インデックス + 全 FK** を作成 | 404 |
| 2 | `20260415062105_add_estimates` | `estimates` テーブルを追加 (見積もり機能) | 27 |
| 3 | `20260415063415_add_retrospectives` | `retrospectives` / `retrospective_comments` テーブルを追加 (振り返り機能) | 44 |
| 4 | `20260415064254_add_email_verification_tokens` | `email_verification_tokens` テーブルを追加 (メール検証トークン) | 14 |
| 5 | `20260415090704_add_password_reset_tokens` | `password_reset_tokens` テーブルを追加 (パスワードリセット用) | 14 |
| 6 | `20260416_add_actual_dates` | `tasks` に `actual_start_date` / `actual_end_date` カラム追加 (実績日) | 3 |
| 7 | `20260416_add_task_type_wbs_hierarchy` | `tasks.type` (`work_package` / `activity`) 追加、WP では不要な `assignee_id` / `planned_start_date` / `planned_end_date` を nullable 化、`planned_effort DEFAULT 0` | 15 |
| 8 | `20260418_visibility_and_risk_nature` | PR #60。`risks_issues` に `visibility` / `risk_nature` 列追加、`retrospectives` に `visibility` 列追加、旧値 `project` / `company` を `public` に集約する UPDATE 文 (**要確認**: SQL 本文で `UPDATE "knowledge"` (単数) と記述されているが実テーブル名は `knowledges` (複数)。そのまま実行すると `relation "knowledge" does not exist` になる可能性あり。本番適用状況は Supabase で要確認) | 16 |
| 9 | `20260419_attachments` | PR #64。`attachments` テーブル追加 (URL 参照型の汎用添付、`entity_type + entity_id` のポリモーフィック関連) | 33 |
| 10 | `20260419_project_process_tags_and_suggestion` | PR #65。`projects.process_tags` 追加、**pg_trgm 拡張を有効化** (`CREATE EXTENSION IF NOT EXISTS pg_trgm`)、`knowledges.title` / `knowledges.content` / `risks_issues.title` / `risks_issues.content` / `retrospectives.problems` / `retrospectives.improvements` に GIN トライグラムインデックス、`knowledges.business_domain_tags` 追加 | 38 |
| 11 | `20260420_memos` | PR #70。`memos` テーブル追加 (個人メモ、プロジェクト非依存) | 27 |
| 12 | `20260420_user_theme_preference` | PR #72。`users.theme_preference VARCHAR(30) NOT NULL DEFAULT 'light'` 追加 (画面テーマ設定の永続化) | 5 |
| 13 | `20260423_customers` | PR #111-1。`customers` テーブル追加 (顧客マスタ) + `projects.customer_id` 追加 (NULL 許可で互換期間) | - |
| 14 | `20260424_drop_project_customer_name` | PR #111-2。`projects.customer_name` 廃止、`customer_id` を NOT NULL 化 | - |
| 15 | `20260424_mfa_lock_columns` | PR #116。`users.mfa_failed_count` / `mfa_locked_until` 追加 (MFA verify ロック) | - |
| 16 | `20260424_system_error_logs` | PR #115。`system_error_logs` テーブル追加 (内部エラーの構造化保存) | - |
| 17 | `20260424_user_i18n_preferences` | PR #118。`users.timezone` / `locale` 追加 (個別 i18n 設定) | - |
| 18 | `20260427_stakeholders` | **PR #149**。`stakeholders` テーブル追加 (ステークホルダー管理、PMBOK 13)。1-5 段階の CHECK 制約 + ON DELETE SET NULL FK + JSONB tags | 70 |

> **検証方法**: Supabase ダッシュボード → Database → Tables で各テーブルの有無 / カラム構成を目視、もしくは SQL Editor で `SELECT * FROM information_schema.columns WHERE table_name = '<テーブル名>';` を実行。

> **⚠ 適用漏れ事例 (2026-04-27)**: PR #149 マージ後、`prisma/migrations/20260427_stakeholders/migration.sql` を Supabase 本番に適用し忘れ、本番のステークホルダータブで `relation "public.stakeholders" does not exist` (Prisma `P2021`) が発生した。**E2E テストはテスト DB に対して走り、テスト DB は CI セットアップで自動マイグレートされるため、本番 DB との drift は構造的に検知できない**。**新規マイグレーションを含む PR をマージしたら、本セクションのリストに追記しつつ §3.3 の手順で本番に手動適用するルールを徹底すること。** (関連: docs/developer/E2E_LESSONS_LEARNED.md §4.39)

---

## 5. Vercel デプロイ手順

### 5.1 `vercel.json` の内容 (ファイル全文)

```json
{
  "installCommand": "pnpm install",
  "buildCommand": "pnpm prisma generate && pnpm build",
  "crons": [
    {
      "path": "/api/health",
      "schedule": "0 0 * * *"
    }
  ]
}
```

- **buildCommand**: Prisma Client 生成 → Next.js ビルドのみ。`prisma migrate deploy` は**含まない** (§3.3 の理由による)
- **crons**: `/api/health` を **毎日 00:00 UTC** にヒット (ウォームアップの保険。5 分間隔のウォームアップは外部 cron-job.org で別設定、詳細は §9)

### 5.2 通常デプロイ (スキーマ変更を含まない場合)

**前提**: Vercel プロジェクトは GitHub リポジトリと接続済み (要確認: Vercel Dashboard で対象プロジェクトの Git 連携設定)。

```bash
# 1. 機能ブランチで作業しコミット
git checkout -b feat/xxx
# ... 編集 ...
git add .
git commit -m "機能追加: xxx"
git push -u origin feat/xxx

# 2. GitHub 上で Pull Request を作成
#    → Vercel が PR ごとに Preview Deployment を自動生成

# 3. PR レビュー・動作確認後、main にマージ
#    → Vercel が main ブランチの Production Deployment を自動生成

# 4. 本番 URL (https://tasukiba.vercel.app) にアクセスし動作確認
```

### 5.3 スキーマ変更を含むデプロイ

手順の **順序が非常に重要**: **マイグレーション適用を先、デプロイを後** にしないと、新コードが旧スキーマのまま起動して `column X does not exist` 等のエラーになる。

#### 推奨手順

```bash
# 1. 機能ブランチで開発 + ローカルマイグレーション作成
git checkout -b feat/xxx
# prisma/schema.prisma を編集
npx prisma migrate dev --name xxx
# ... アプリコード修正 ...
git add .
git commit -m "スキーマ変更: xxx"
git push -u origin feat/xxx

# 2. PR 作成 → レビュー
```

**マージ手順**:

1. **本番 DB にマイグレーションを先に適用** (§3.3 の手順)
   - Supabase ダッシュボード → SQL Editor → `migration.sql` 全文貼付 → Run
   - "Success" を確認
2. マイグレーションが列追加 (ADD COLUMN) かつ `DEFAULT` 指定があるなら、旧コードも**既存のまま動く** (ADD COLUMN は互換性あり)
3. 本番 DB 更新後、**GitHub で PR をマージ** → Vercel が自動デプロイ
4. デプロイ完了後、<https://tasukiba.vercel.app> にアクセスし動作確認

#### 破壊的変更 (DROP / RENAME) の場合

旧コードと新コードがしばらく併存することを考慮し、**2 段デプロイ** を検討:
- PR (a): 新旧両対応のコードをマージ + マイグレーションは後回し
- Supabase で手動マイグレーション適用
- PR (b): 旧列への参照を削除

**要確認**: 本プロジェクトでは現状、破壊的変更の手順例は未定義。初回適用時にユーザメンテナンス時間を取ることを推奨。

---

## 6. 障害対応

### 6.1 Vercel ビルド失敗

#### 症状
- Vercel Dashboard → Deployments のステータスが **Failed**
- "Build Command" のログにエラー

#### 調査手順

1. Vercel Dashboard → 該当 Deployment → **Build Logs** を開く
2. 最後のエラー行を特定

#### よくある原因と対処

| 症状 | 原因 | 対処 |
|---|---|---|
| `Cannot find module '@/generated/prisma'` | `pnpm prisma generate` が未実行 (buildCommand のどこかで失敗) | `vercel.json` の `buildCommand` が `pnpm prisma generate && pnpm build` のままか確認 |
| `DATABASE_URL is not defined` | Vercel 環境変数未設定 | Project Settings → Environment Variables で `DATABASE_URL` / `DIRECT_URL` 等を設定。Production / Preview / Development それぞれにスコープ指定 |
| `Type error: ...` (TypeScript) | 型エラー | ローカルで `pnpm build` を事前実行して同じエラーを再現し、コード側で修正 |
| ESLint エラー | lint ルール違反 | ローカルで `pnpm lint` を実行して修正 |

### 6.2 DB 接続失敗 (アプリ起動時)

#### 症状
- Vercel 関数ログに `PrismaClientInitializationError` や `Connection terminated unexpectedly`
- `/settings` 等の DB 依存ページで 500 エラー

#### 対処

1. Vercel Dashboard → Deployment → **Runtime Logs** でエラーメッセージを特定
2. 接続 URL の確認:
   - `DATABASE_URL` が **Pooler URL** (`pooler.supabase.com:6543` + `?pgbouncer=true`) になっているか
   - `DIRECT_URL` が **直結 URL** (`db.[ref].supabase.co:5432`) になっているか
3. Supabase Dashboard → Database → **Roles** で `postgres` パスワードが変更されていないか確認 (変更時は全環境変数を更新)
4. Supabase 側の **Project Pause**: Free プランは 1 週間アクセスがないと自動 pause される。Dashboard から **Resume** する

### 6.3 マイグレーション失敗

#### 症状
- Supabase SQL Editor で `ERROR: ...` が返る
- 本番で `column X does not exist` / `relation Y does not exist`

#### 対処

| エラー | 原因 | 対処 |
|---|---|---|
| `ERROR: 42601: syntax error at or near "prisma"` | SQL 本文ではなくファイルパスを貼付 | **ファイル内の SQL テキストを丸ごとコピー** して貼付 (README の警告参照) |
| `ERROR: 42703: column "X" of relation "Y" does not exist` | 過去のマイグレーションが未適用 | §4 のマイグレーション一覧で未適用を特定 → 古い順に 1 件ずつ SQL Editor で実行 |
| `ERROR: 42P01: relation "X" does not exist` | 同上、もしくはテーブル名の typo | §4 第 8 番 (`20260418_visibility_and_risk_nature`) の既知事案 (`knowledge` vs `knowledges`) は特に要注意 |
| `ERROR: 42710: extension "pg_trgm" already exists` | 2 回目以降の適用 | `CREATE EXTENSION IF NOT EXISTS` なら無視してよい。`IF NOT EXISTS` 無しなら既に適用済みの証拠 |

### 6.4 ローカル開発で `pnpm dev` 起動失敗

| 症状 | 原因 | 対処 |
|---|---|---|
| `Error: P1001: Can't reach database server` | ローカル PostgreSQL が起動していない | Docker Compose を起動、もしくは `DATABASE_URL` を Supabase のものに切替 |
| `Error: P2021: The table ... does not exist` | マイグレーション未適用 | `npx prisma migrate dev` を実行 |
| `next dev` 起動後 `http://localhost:3000` で 500 | `NEXTAUTH_SECRET` 未設定 | `openssl rand -base64 32` で生成して `.env` に設定 |

---

## 7. ロールバック手順

### 7.1 Vercel の前バージョンへのロールバック (コードのみ)

Vercel の **Rollback** 機能を使う。DB マイグレーションは巻き戻らない点に注意。

#### 手順

1. Vercel Dashboard → 対象プロジェクト → **Deployments** タブ
2. 戻したいバージョン (緑の **Ready** バッジが付いた過去の Production) を選択
3. 右上の **⋯** (メニュー) → **Promote to Production** (Vercel UI のバージョンにより **Instant Rollback** / **Rollback** と表記される場合あり、要確認)
4. 即座に本番 URL が指定バージョンに切り替わる (新規ビルド不要、数秒〜数十秒)

**補足** (Vercel の公式仕様):
- 過去のデプロイは一定期間保持される
- Rollback はコードのみ。**DB スキーマは戻らない**

### 7.2 DB マイグレーションのロールバック

Prisma の migrate には down マイグレーションの機能がない (`prisma migrate dev` は forward のみ)。本番でスキーマを戻すには **逆 SQL を手動で書く** 必要がある。

#### 手順

1. 直近適用したマイグレーションの中身を確認

   ```bash
   pnpm migrate:print <migration-name>
   ```

2. 逆操作の SQL を手で書く。例:
   - `ADD COLUMN foo ...` → `ALTER TABLE xxx DROP COLUMN foo;`
   - `CREATE TABLE foo (...)` → `DROP TABLE foo;`
   - `CREATE INDEX foo ON ...` → `DROP INDEX foo;`
   - `UPDATE ... SET x = 'A' WHERE x = 'B'` → **戻せない可能性あり** (上書き情報の記録がない限り不可逆)

3. Supabase SQL Editor で実行

4. `prisma/migrations/_prisma_migrations` テーブル (要確認: Prisma 7 での実テーブル名) から当該行を削除

   ```sql
   DELETE FROM "_prisma_migrations" WHERE migration_name = '<migration-name>';
   ```

5. Vercel のコードも §7.1 で対応バージョンへ戻す

> ⚠ **破壊的操作** なので事前に Supabase Dashboard → Database → **Backups** で現状バックアップを取得してから実施。Supabase Free プランでも Point-in-Time Recovery (7 日) が使える (要確認)。

### 7.3 全面復旧 (バックアップからのリストア)

Supabase Dashboard → Database → **Backups** タブで過去のスナップショットから復旧する。要確認 (現プロジェクトで実施したことがあるか、本書では記録なし)。

---

## 8. 定期実行 (Cron) 構成

本アプリには以下の定期実行がある。

| 目的 | 実行元 | エンドポイント | 頻度 | 認証 |
|---|---|---|---|---|
| **ウォームアップ** (コールドスタート抑制) | **外部**: cron-job.org | `GET /api/health` | **5 分間隔** (業務時間帯のみ推奨) | 不要 (公開エンドポイント) |
| ウォームアップ保険 | Vercel Cron (Hobby プラン) | `GET /api/health` | 日次 00:00 UTC | 不要 |
| 未使用アカウントロック | Vercel Cron | `POST /api/admin/users/lock-inactive` | 日次 03:00 UTC | `Authorization: Bearer ${CRON_SECRET}` または admin セッション |
| **アプリ内通知 (PR feat/notifications-mvp)** | Vercel Cron | `POST /api/cron/daily-notifications` | **日次 22:00 UTC (= JST 翌日 7:00)** | `Authorization: Bearer ${CRON_SECRET}` のみ (cron 専用) |

※ `/api/cron/cleanup-accounts` は PR #115 で削除 (デッドコード)。`/api/admin/users/lock-inactive` に一本化した (旧名 `cleanup-inactive`、feat/account-lock で改名)。vercel.json の `crons` も同 endpoint を参照。

### 「アプリ内通知」cron の挙動 (PR feat/notifications-mvp、2026-05-01)

**処理内容** (1 リクエストで以下を順次実行):

1. **開始通知生成**: ACT (`type='activity'`) で `status='not_started'` AND `plannedStartDate=today (JST)` AND `assigneeId IS NOT NULL` のタスクを抽出 → 各 assignee に通知作成
2. **終了通知生成**: 同 ACT で `status≠'completed'` AND `plannedEndDate=today (JST)` AND `assigneeId IS NOT NULL` のタスクを抽出 → 各 assignee に通知作成
3. **古い通知の物理削除**: `readAt > 30日` の既読通知を `deleteMany`

**コスト**: アプリ内通知のみ (メール / push 不使用)、Vercel Cron Hobby = 2/day 無料枠で完結。

**重複抑止**: `dedupeKey = '{type}:{taskId}:{YYYY-MM-DD}'` の UNIQUE 制約 + `createMany skipDuplicates: true` で 2 重生成を DB レベルで弾く。cron が時間内に再呼出されても安全。

**監視ポイント**:
- レスポンスの `data.generated.{startCreated, endCreated}` が想定外に 0 連続 → cron 落ち or タスクの date / status / assignee 設定不全の疑い
- レスポンスの `data.cleaned.deleted` が累積で増えない → 既読通知が永続化される異常 (UI 側の既読化が動いていない可能性)

**手動実行** (動作確認用):

```bash
curl -X POST https://tasukiba.vercel.app/api/cron/daily-notifications \
  -H "Authorization: Bearer ${CRON_SECRET}"
```

`200 OK` + `data.source='cron'` で正常動作。

### 「未使用アカウントロック」の挙動 (feat/account-lock 改修、2026-04-25)

旧仕様 (PR #89) は閾値経過の非 admin を **論理削除** していたが、ナレッジ参照のため
アカウントを残し **isActive=false (ロック)** にする方針へ変更:

- **ロック対象**: `lastLoginAt` (未ログインなら `createdAt`) から 30 日経過した非 admin
- **挙動**: `users.isActive = false` のみ更新 (deletedAt セット / ProjectMember 物理
  削除は **行わない**)
- **影響**: ログイン不可になるが、過去のナレッジ/課題/振り返り等の作成者表示はそのまま
- **解除手段**: `/admin/users` で当該ユーザ行を編集 → 「有効化」をオン → 保存
- **監査**: action='UPDATE' / entityType='user' / after.reason='30 日無アクティブ自動ロック'
  を audit_log に記録

### 8.1 なぜ外部 cron サービスを使うのか

Vercel Hobby プランの Cron Jobs は **日次 (1 日 1 回) の頻度制限** があり、5 分間隔のウォームアップには対応できない。Pro プラン ($20/月) にアップグレードするか、外部 cron サービスを使う必要がある。本プロジェクトはコスト優先で **外部 cron (cron-job.org)** を採用。

ref: <https://vercel.com/docs/cron-jobs/usage-and-pricing>

---

## 9. cron-job.org ウォームアップ設定手順

### 9.1 新規ジョブ作成

1. <https://console.cron-job.org/dashboard> にログイン
2. **「CREATE CRONJOB」** をクリック
3. 以下を入力:

| 項目 | 値 |
|---|---|
| Title | `tasukiba warm-up` |
| URL | `https://tasukiba.vercel.app/api/health` |
| Execution schedule | **Every 5 minutes** (Common schedules のプリセット、または Custom で `*/5 * * * *`) |
| Enabled | ✅ ON |

オプション (推奨):

| 項目 | 値 | 理由 |
|---|---|---|
| Request method | GET | DB ping のみの副作用なし設計 |
| Notification on failure | ON | 失敗検知を有効化 |
| Execution window | 業務時間帯のみ (例: 平日 07:00-22:00 JST) | 深夜帯のウォームアップは不要。業務時間外はコスト最適 |

### 9.2 動作確認

1. ジョブ作成後、**「SAVE」** で保存
2. Dashboard に戻って **Last Events** で最初の実行を確認
3. HTTP 応答が **200 OK**・レスポンス時間が 2 秒以下であることを確認
4. 応答本文例:
   ```json
   {
     "status": "ok",
     "timestamp": "2026-04-17T10:30:14.123Z",
     "db": "ok",
     "responseTimeMs": 145
   }
   ```

### 9.3 アラート設定 (推奨)

cron-job.org の **Settings → Notifications** で以下を有効化:
- E-mail on failure: ON
- 通知先メールアドレス: 運用責任者

---

## 10. ヘルスチェックエンドポイント仕様

### 10.1 エンドポイント

`GET https://tasukiba.vercel.app/api/health`

### 10.2 応答

| 状態 | HTTP | `body.status` | `body.db` |
|---|---|---|---|
| 正常 | 200 | `ok` | `ok` |
| DB エラー | 503 | `degraded` | `error` |
| DB タイムアウト (5 秒) | 503 | `degraded` | `timeout` |

### 10.3 処理内容

- `SELECT 1` を DB に実行 (最小の DB ping)
- 応答時間を `responseTimeMs` に含む
- 副作用なし (書き込みなし)
- キャッシュ禁止 (`dynamic = 'force-dynamic'`)
- `/api/health` は環境変数なしで動作する (`DATABASE_URL` 不通でも `db: error` を返して 503 応答)

---

## 11. 死活監視

### 11.1 cron-job.org による監視

`/api/health` への 5 分毎の ping により、以下を実質監視できる:
- Vercel Function の起動可否
- Supabase DB への接続可否
- レスポンス時間 (`responseTimeMs`)

### 11.2 障害通知フロー

1. cron-job.org がエンドポイント失敗を検知 → 登録メールに通知
2. 運用担当が Vercel ダッシュボード・Supabase ダッシュボードで状態確認
3. 必要なら Vercel ログ・Supabase ログを確認して原因切り分け (本書 §6 障害対応へ)

---

## 12. 今後追加予定の運用項目

- Vercel Speed Insights 有効化 (TTFB / LCP / CLS の継続記録)
- Supabase `pg_stat_statements` 活用 (遅いクエリの自動検知)

## 13. セキュリティ運用 (PR #122 で追加)

本アプリの多層防御実装の詳細は [`docs/developer/SPECIFICATION.md §25`](../developer/SPECIFICATION.md#25-セキュリティ実装の全体像-多層防御-pr-122-で整理) を参照。本節は **運用担当 (管理者) が日常業務で実施する確認手順** に絞る。

### 13.1 エラー発生状況の確認 (`system_error_logs`)

全エラーは `system_error_logs` テーブルに集約記録される (PR #115)。日次 / 週次で Supabase SQL Editor から以下を実行し、急増・異常を早期検知する:

```sql
-- 過去 24 時間のエラー発生件数 (カテゴリ別)
SELECT category, COUNT(*) AS cnt
FROM system_error_logs
WHERE created_at >= now() - interval '24 hours'
GROUP BY category
ORDER BY cnt DESC;

-- 直近の個別エラー (調査用、message は秘匿情報を含む可能性があるため admin のみアクセス)
SELECT id, category, created_at, LEFT(message, 200) AS message_preview
FROM system_error_logs
ORDER BY created_at DESC
LIMIT 20;
```

**運用ルール**:
- 24 時間で同カテゴリ 50 件超はアラート発火 (将来 Vercel Speed Insights / Sentry 等と連携)
- 機密情報 (メール本文・パスワード等) が message / stack に混入していないかスポットチェック
- 1 ヶ月経過ログは削除 or S3 archive (`cron/cleanup-accounts` と同様の退避バッチ、未実装 — 将来対応)

### 13.2 MFA ロック発生時の対応 (PR #116)

ユーザから「ログインできない」問い合わせがあった場合の分岐フロー:

1. `/admin/users` 画面で対象ユーザを開き、**ログインロック情報** セクションを確認
2. 表示パターンと対応:

| 表示 | 意味 | 対応 |
|---|---|---|
| 「一時ロック: YYYY/MM/DD HH:MM まで」(password ロック) | 5 回連続パスワード失敗で 30 分ロック (PR #85) | 本人に時間経過を案内、急ぎなら「ロック解除」ボタン |
| 「MFA 一時ロック: YYYY/MM/DD HH:MM まで」(MFA ロック) | 3 回連続 TOTP 失敗で 30 分ロック (PR #116) | 本人にリカバリコード使用 or 時間経過を案内、急ぎなら admin が「MFA ロック解除」 |
| 「永続ロック: あり」 | 管理者による無効化 (解除には admin 操作必須) | 解除すべきか判断後、`unlock` API 経由で解除 |

### 13.3 セキュリティ関連環境変数の確認

本番デプロイ前に以下が設定済みであることを確認 (既存 §1 参照):

- `NEXTAUTH_SECRET` — 32 バイトのランダム文字列 (JWT 署名鍵)
- `CRON_SECRET` — cron 認証鍵 (未設定なら cron 機能無効)
- `CI_TRIGGER_PAT` — CI 自動再起動用 PAT (PR #121、[DEVELOPER_GUIDE §9.6](../developer/DEVELOPER_GUIDE.md) 参照、期限管理必須)

### 13.4 インシデント発生時のトリアージ

詳細は [§6 障害対応](#6-障害対応) に準ずるが、**セキュリティインシデント (漏洩疑い)** の場合は追加で:

1. `system_error_logs` を過去 1 週間分取得して message / stack に含まれる **機密情報の種別** を特定
2. 影響範囲: 該当 userId / プロジェクト / 顧客情報を洗い出し
3. 必要に応じて `NEXTAUTH_SECRET` をローテーションして全 JWT を無効化 (強制再ログイン)
4. admin 監査ログ (`audit_logs`) も併せて確認し、異常アクセスパターンを検出

---

## 付録 A. GitHub Actions の状況

`.github/workflows/` には以下のファイルのみ存在 (2026-04-20 時点):

| ファイル | ステータス |
|---|---|
| `security.yml.template` | **テンプレート** (拡張子 `.template` のため GitHub Actions は実行しない) |

> 有効化する場合は拡張子を外して `security.yml` にリネーム。内容 (gitleaks / npm audit / Semgrep / CodeQL) の詳細はファイル冒頭のコメント参照。

## 付録 B. 本書に書かれていないこと (別ドキュメント参照)

| トピック | 参照先 |
|---|---|
| アーキテクチャ・ER 図・権限設計 | [docs/developer/DESIGN.md](../developer/DESIGN.md) |
| 機能仕様・画面仕様 | [docs/developer/SPECIFICATION.md](../developer/SPECIFICATION.md) |
| MVP スケジュール | [docs/developer/PLAN.md](../developer/PLAN.md) |
| 運用で得られた教訓 | [docs/developer/knowledge/](../developer/knowledge/) |
| パフォーマンス改修記録 | [docs/developer/performance/](../developer/performance/) |

---

## 更新履歴

| 日付 | 変更内容 | 担当 |
|---|---|---|
| 2026-04-17 | パフォーマンス改修 (listTasksWithTree / Gantt 背景最適化 / TaskTreeNode memo 化 / Knowledge limit 削減) — PR #25 | - |
| 2026-04-17 | `/api/health` + instrumentation + Vercel 日次 cron 追加 — PR-α | - |
| 2026-04-20 | 旧 `OPERATIONS.md` (複数形) を本書に統合し運用手順を一本化 (§8〜§12 と既存改修履歴を吸収) | - |
| 2026-04-20 | 初版作成。README.md / .env.example / prisma/migrations/ / .github/workflows/ / vercel.json / package.json から事実ベースで構成 | - |
