# 障害対応とロールバック (Operations)

本ドキュメントは、本番障害発生時の対応手順とロールバック手順を集約する (OPERATION.md §6〜§7)。

---

## §6. 障害対応

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


## §7. ロールバック手順

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

