# ローカル開発環境の起動 (Operations)

本ドキュメントは、ローカル環境でのアプリ起動手順を集約する (OPERATION.md §2)。環境変数は [ENV_VARS.md](./ENV_VARS.md) を参照。

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

