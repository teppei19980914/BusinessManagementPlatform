# DB マイグレーション手順 (Operations)

本ドキュメントは、Prisma migration の作成・適用・ロールバック手順を集約する (OPERATION.md §3〜§4)。

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

### 3.3 Supabase 本番への適用 (Vercel ビルド時自動 + 緊急時手動)

> **2026-05-03 PR fix/missing-migrations 改修**: 従来の **「Supabase ダッシュボード SQL Editor で手動実行」** 運用を、**Vercel ビルド時の `prisma migrate deploy` 自動実行** に切り替えた。手動実行は緊急時のフォールバックとして残す。
>
> 改修理由: 手動 SQL Editor 運用は migration ごとに人手作業を強いる + 適用漏れ事故が発生しうる (実際 PR #229 マージ後に `tenant_id` 列が本番に反映されず本番ログイン全停止の事故が発生)。

#### 3.3.1 通常運用: Vercel 自動デプロイ (推奨)

**前提条件**:

| 設定項目 | 値 | 設定場所 |
|---|---|---|
| `vercel.json` の `buildCommand` | `pnpm prisma generate && pnpm prisma migrate deploy && pnpm build` | リポジトリ |
| `prisma.config.ts` の `datasource.url` | `process.env['DIRECT_URL'] || process.env['DATABASE_URL']` (DIRECT_URL 優先) | リポジトリ |
| Vercel 環境変数 `DATABASE_URL` | `postgresql://postgres.[ref]:[pw]@aws-1-ap-northeast-1.pooler.supabase.com:6543/postgres?pgbouncer=true` (Transaction pooler) | Vercel |
| Vercel 環境変数 `DIRECT_URL` | `postgresql://postgres.[ref]:[pw]@aws-1-ap-northeast-1.pooler.supabase.com:5432/postgres` (Session pooler、port **5432** 注意) | Vercel |

**重要**: Prisma 7 から `url` / `directUrl` を `schema.prisma` に書けなくなり (P1012 エラー)、`prisma.config.ts` の `datasource.url` で指定する仕様に変更されている。ランタイム (PrismaClient) は `process.env.DATABASE_URL` を自動利用、migrate 系は `prisma.config.ts` で指定した URL を使う。

**仕組み**:
- Vercel ビルド時に `prisma migrate deploy` が `DIRECT_URL` 経由で本番 DB に未適用の migration を順番に適用
- pgbouncer (port 6543) は prepared statement 不可で DDL 失敗するため `DIRECT_URL` で **session pooler (port 5432)** を使う必要あり
- pgvector 等の **拡張は事前に Supabase Dashboard → Extensions で手動有効化**しておくこと (`CREATE EXTENSION` は Supabase 権限制限で migration 内では失敗するケースあり)

**確認手順**:
1. Vercel ビルドログで `Applying migration X_Y_Z` 等のメッセージを確認
2. Supabase SQL Editor で `SELECT * FROM _prisma_migrations ORDER BY finished_at DESC LIMIT 5;` を実行し、最新 migration が適用されているか確認

#### 3.3.2 緊急時: ローカルから本番へ手動 deploy

Vercel ビルドが失敗していて本番デプロイ自体ができないが、DB は適用したい状況 (例: 本番ログイン障害が起きていて先に DB を整えたい):

```bash
# 1. .env.local に本番 DATABASE_URL / DIRECT_URL を一時設定
#    (.env.local は git ignore 対象なのでコミットされない)

# 2. ローカルから本番 DB に migrate deploy
pnpm db:deploy
# = pnpm prisma migrate deploy

# 3. 適用結果を Supabase SQL Editor で確認
#    SELECT migration_name, finished_at FROM _prisma_migrations ORDER BY finished_at DESC LIMIT 10;

# 4. 必ず .env.local から本番 URL を削除 (誤操作防止)
```

⚠ **本番 DB 接続情報をローカルに置く期間は最小化**。作業完了後は `.env.local` から削除すること。誤って `pnpm db:reset` を実行すると本番 DB が全消去される事故になる。

#### 3.3.3 Supabase Dashboard SQL Editor 手動 (最終手段)

`prisma migrate deploy` がどうしても通らない場合 (拡張権限、独自 SQL 構文等):

1. ローカルで SQL 本文を表示

   ```bash
   pnpm migrate:print <migration-name>
   # 例: pnpm migrate:print 20260502_multi_tenant_base
   ```

   もしくは GitHub 上で `prisma/migrations/<name>/migration.sql` を開き、**Raw** ボタンから全文コピー。

2. Supabase ダッシュボードを開く → **SQL Editor** → 新規クエリ

3. コピーした **SQL テキスト全体** を貼り付け ( **ファイルパスを貼り付けない** )

   > ⚠ `prisma/migrations/.../migration.sql` とパスを貼ると `ERROR: 42601: syntax error at or near "prisma"` になる (README にも明記)。必ず中身の SQL テキストを貼る。

4. **Run** (または `Ctrl+Enter`) で実行

5. "Success. No rows returned" が表示されれば成功

6. **RLS 警告が出た場合**: **Run without RLS** を選択 (本プロジェクトは全テーブル RLS なし運用、既存テーブルと同方針)

7. 適用後、`_prisma_migrations` テーブルに該当行を手動追加 (Prisma の認識を合わせる):

   ```sql
   INSERT INTO _prisma_migrations
     (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
   VALUES
     (gen_random_uuid()::text, '<schema.prismaから取得>', now(), '<migration-name>', null, null, now(), 1);
   ```

   または `pnpm prisma migrate resolve --applied <migration-name>` (DIRECT_URL が通っていれば)。

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


## DESIGN.md §14. DB マイグレーション戦略

## 14. DB マイグレーション戦略

### 14.1 ツール

Prisma Migrate を使用する。マイグレーションファイル（SQL）は自動生成され、Git で管理する。

### 14.2 開発環境の運用ルール

| ルール | 内容 |
|---|---|
| マイグレーション生成 | `pnpm prisma migrate dev --name <変更内容>` |
| 命名規則 | 英語スネークケース（例: `add_mfa_columns_to_users`） |
| 1マイグレーション1変更 | テーブル追加とカラム追加は分割する |
| データ投入 | マイグレーション内でデータ投入しない（シードスクリプトで分離） |
| リセット | `prisma migrate reset` で全リセット可（開発環境のみ） |
| Git 管理 | prisma/migrations/ を必ずコミット |

### 14.3 本番環境の運用ルール

#### 適用フロー

```
[1] PR でマイグレーションファイルをレビュー
    - 破壊的変更がないか
    - ロック時間が長くないか
    |
    v
[2] ステージング環境で適用テスト
    |
    v
[3] 本番適用: pnpm prisma migrate deploy
    |
    v
[4] 適用結果の確認
```

#### 破壊的変更の安全な適用手順

| 変更種別 | 安全な手順 |
|---|---|
| NOT NULL カラム追加 | (1) デフォルト値付きで追加 → (2) データ埋め → (3) NOT NULL 制約追加 |
| カラム名変更 | (1) 新カラム追加 → (2) データコピー → (3) アプリ切替 → (4) 旧カラム削除 |
| カラム削除 | (1) アプリから参照除去 → (2) デプロイ → (3) カラム削除 |
| テーブル削除 | (1) アプリから参照除去 → (2) デプロイ → (3) テーブル削除 |
| インデックス追加（大テーブル） | CREATE INDEX CONCURRENTLY を使用（ロック回避） |

### 14.4 禁止事項

| 禁止事項 | 理由 |
|---|---|
| 生成された SQL ファイルの手動編集 | Prisma の整合性管理が破損する |
| 適用済みマイグレーションファイルの削除 | 履歴が失われ、環境間で不整合が発生する |
| 本番環境での `prisma migrate reset` | 全データが消失する |
| 本番環境での `prisma db push` | マイグレーション履歴をバイパスする |

---

