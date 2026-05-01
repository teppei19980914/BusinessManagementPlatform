# 開発者オンボーディング — 環境構築から PR 作成まで

> 本書は、**たすきば Knowledge Relay の開発に初めて参加する開発者** 向けの一貫手順書です。
> 開発環境の構築から、コード改修、テスト、コミット、PR 作成までを、この 1 ファイルを順に辿るだけで完了できるように書いています。

---

## 0. 前提

本プロジェクトは以下の構成です。

- **フロントエンド + バックエンド**: Next.js 16 (App Router) / React 19 / TypeScript
- **DB**: PostgreSQL 16 (Prisma 7 + @prisma/adapter-pg)
- **認証**: NextAuth.js (Auth.js) v5
- **テスト**: Vitest (ユニット) + Playwright (E2E / 視覚回帰)
- **デプロイ**: Vercel + Supabase

**用語** (頻出のみ、詳細は [developer/SPECIFICATION.md](../developer/SPECIFICATION.md)):

| 用語 | 意味 |
|---|---|
| プロジェクト | 業務案件の単位。企画 → 実行 → 振り返りの State Machine を持つ |
| WBS / タスク | プロジェクト配下の作業階層 (Work Package → Activity の 2 層) |
| ナレッジ | プロジェクトで蓄積した知見。公開範囲制御付き |
| メモ | 個人単位の一時メモ (private / public の 2 段階) |
| 見積もり | プロジェクト工数見積もり |
| リスク / 課題 | プロジェクトのリスク・発生した課題の追跡 |
| 振り返り | プロジェクト完了後の KPT 形式振り返り |

---

## 1. 開発環境の構築 (30 分目安)

### 1.1 必要なソフトウェア

インストールされていない場合、下記を先にセットアップ:

| ツール | 理由 | 確認コマンド |
|---|---|---|
| [Node.js 22 LTS](https://nodejs.org/) | ランタイム | `node -v` |
| [pnpm](https://pnpm.io/installation) | パッケージマネージャ | `pnpm -v` |
| [Docker Desktop](https://www.docker.com/products/docker-desktop/) (任意) | ローカル PostgreSQL 用。Supabase クラウド接続する場合は不要 | `docker -v` |
| [GitHub CLI (`gh`)](https://cli.github.com/) | PR 作成で使用 | `gh --version` |

### 1.2 リポジトリ取得 + 依存インストール

```bash
git clone https://github.com/teppei19980914/BusinessManagementPlatform.git
cd BusinessManagementPlatform
pnpm install
```

### 1.3 環境変数の設定

```bash
cp .env.example .env
```

`.env` を開き、最低限下記を埋めます (詳細は [administrator/OPERATION.md](../administrator/OPERATION.md) §「環境変数」を参照):

| キー | 設定例 | 意味 |
|---|---|---|
| `DATABASE_URL` | `postgresql://postgres:postgres@localhost:5432/tasukiba` (Docker) または Supabase の Pooler URL | DB 接続文字列 |
| `AUTH_SECRET` | `openssl rand -base64 32` で生成した値 | NextAuth の JWT 暗号鍵 |
| `NEXTAUTH_URL` | `http://localhost:3000` | コールバック URL |
| `INITIAL_ADMIN_EMAIL` | あなたのメールアドレス | 初期管理者 |
| `INITIAL_ADMIN_PASSWORD` | 任意の強いパスワード | 初期管理者の初回パスワード |

### 1.4 DB のセットアップ

**ローカル PostgreSQL (Docker) の場合**:
```bash
docker compose up -d db
```

**Supabase クラウド接続の場合**: `.env` の `DATABASE_URL` が Supabase 向けに設定されていれば次のステップへ。

Prisma Client 生成 + migration 適用 + 初期管理者シード:
```bash
npx prisma generate
npx prisma migrate dev
pnpm db:seed
```

### 1.5 開発サーバ起動 + 動作確認

```bash
pnpm dev
```

http://localhost:3000 を開き、`.env` の `INITIAL_ADMIN_EMAIL` / `INITIAL_ADMIN_PASSWORD` でログインできれば成功です。初回は強制的にパスワード変更と MFA 設定が要求されます (admin は MFA 必須)。

---

## 2. コードベースの歩き方

### 2.1 主要ディレクトリ

| パス | 役割 |
|---|---|
| `src/app/(auth)/` | ログイン / パスワード設定 / MFA 画面 |
| `src/app/(dashboard)/` | ログイン後の全画面 (projects / tasks / gantt / estimates / risks / retrospectives / knowledge / memos / settings / admin) |
| `src/app/api/` | REST API ルート (Next.js Route Handlers) |
| `src/services/` | ビジネスロジック (DB 操作はここに集約) |
| `src/lib/` | 汎用ヘルパー (auth / db / permissions / validators) |
| `src/components/` | 共通 UI コンポーネント (shadcn/ui ベース) |
| `src/config/` | **業務的意味を持つ定数はすべてここに集約** (マスタデータ / セキュリティ / validation / テーマ / ルーティング) |
| `prisma/` | DB schema / migration |
| `e2e/` | E2E テスト (Playwright) |

### 2.2 まず読むべきドキュメント

| 順 | ドキュメント | 理由 |
|---|---|---|
| 1 | [developer/REQUIREMENTS.md](../developer/REQUIREMENTS.md) | 何を目指しているサービスか |
| 2 | [developer/SPECIFICATION.md](../developer/SPECIFICATION.md) | どの画面で何ができるか (権限マトリクスを含む) |
| 3 | [developer/DESIGN.md](../developer/DESIGN.md) | どう設計されているか (§21.4 ゼロハードコーディング原則は特に重要) |
| 4 | [developer/DEVELOPER_GUIDE.md](../developer/DEVELOPER_GUIDE.md) | 改修の実務手順 (テーマ追加 / マスタデータ追加 / 画面追加 / 既存改修 / DB 変更) |

### 2.3 設計原則 (DESIGN.md §21.4)

**業務的意味を持つ値はハードコードせず、すべて `src/config/` に集約** します。例:
- ステータス列挙 (`TASK_STATUSES`) → `src/config/master-data.ts`
- ログイン失敗ロック回数 → `src/config/security.ts`
- 文字数上限 → `src/config/validation.ts`
- テーマ色 → `src/config/theme-definitions.ts`

詳細は [developer/DEVELOPER_GUIDE.md §1](../developer/DEVELOPER_GUIDE.md) を参照。

---

## 3. 初めての開発 — 小さな改修を 1 件通してみる

実例: 「ログイン失敗許容回数を 5 回から 3 回に変更する」 (= `src/config/security.ts` の 1 行変更)

### 3.1 ブランチを切る

本日付のブランチを使います (セッション開始時に Claude Code が自動作成するが、手動なら):
```bash
git checkout main
git pull origin main
git checkout -b dev/$(date +%Y-%m-%d)
```

### 3.2 コードを変更

`src/config/security.ts` を開き、`LOGIN_FAILURE_MAX` の値を編集します。

### 3.3 テストを追加・更新

本プロジェクトでは **テストコードを伴わない変更は禁止** です ([CONTRIBUTING.md](../../CONTRIBUTING.md) 参照)。定数変更なら:

- 既存のログイン失敗テスト (`src/services/auth-event.service.test.ts` 等) が新しい値で通るか確認
- 閾値 3 回に依存するエッジケースのテストを追加

### 3.4 ローカル検証

コミット前に必ず以下 3 つが成功することを確認:

```bash
pnpm lint    # ESLint: 静的解析エラーゼロ
pnpm test    # Vitest: 全ユニットテスト pass (現 646 件)
pnpm build   # 型チェック + 本番ビルド成功
```

E2E テスト (Playwright) はオプション (重いので PR 時に CI で走る):
```bash
pnpm test:e2e        # CLI 実行
pnpm test:e2e:ui     # Playwright UI モード (推奨、対話的デバッグ)
```

詳細は [developer/DEVELOPER_GUIDE.md §9](../developer/DEVELOPER_GUIDE.md)。

### 3.5 コミット前の 5 項目チェック ([CLAUDE.md](../../CLAUDE.md) より)

- [ ] **横展開**: 同一パターンが他ファイルに残っていないか grep
- [ ] **セキュリティ**: ユーザー入力サニタイズ / 生 SQL / 機密情報ハードコード無し
- [ ] **パフォーマンス**: ループ内 DB 問い合わせ / 不要な再描画無し
- [ ] **テスト整合性**: テストコードの旧文言残留無し
- [ ] **ドキュメント**: 仕様変更なら SPECIFICATION / DESIGN / README / OPERATION を更新

### 3.6 コミット

コミットメッセージは **変更内容を端的に** (CONTRIBUTING.md §3):
```bash
git add src/config/security.ts <テストファイル>
git commit -m "ログイン失敗ロック閾値を 5 → 3 回に変更"
```

禁止事項 (**main / master / develop / release/* / hotfix/* への直接コミット禁止**) は `.claude/hooks/auto-commit.sh` で自動ブロックされます。

### 3.7 プッシュ + PR 作成

```bash
git push -u origin <your-branch-name>
gh pr create --base main --title "ログイン失敗ロック閾値を 5 → 3 回に変更" --body "<変更内容と検証結果>"
```

PR 本文の書き方は [CONTRIBUTING.md §4](../../CONTRIBUTING.md) を参照 (Summary / Test plan の 2 セクションが最低限)。

### 3.8 レビュー → マージ

- CI (ci.yml + e2e.yml + security.yml) が全 green になるまで待つ
- レビュアからのコメントに応答 → 修正 → 再 push
- approve 後、GitHub UI で **Squash and merge** が推奨
- マージ後、翌日のセッション開始時に古い dev ブランチは自動削除される

---

## 4. よくある改修パターン (詳細リンク)

上記の「定数 1 つ変える」以外の典型パターン:

| やりたいこと | 参照先 |
|---|---|
| テーマカラーの追加・変更 | [developer/DEVELOPER_GUIDE.md §2](../developer/DEVELOPER_GUIDE.md) |
| マスタデータ (ステータス等) の追加 | [developer/DEVELOPER_GUIDE.md §3](../developer/DEVELOPER_GUIDE.md) |
| 新しい画面・機能を追加 | [developer/DEVELOPER_GUIDE.md §4](../developer/DEVELOPER_GUIDE.md) |
| 既存機能の改修 | [developer/DEVELOPER_GUIDE.md §5](../developer/DEVELOPER_GUIDE.md) |
| 機能を削除 | [developer/DEVELOPER_GUIDE.md §6](../developer/DEVELOPER_GUIDE.md) |
| DB スキーマ変更 | [developer/DEVELOPER_GUIDE.md §7](../developer/DEVELOPER_GUIDE.md) |
| UI ラベル (i18n) 追加 | [developer/DEVELOPER_GUIDE.md §8](../developer/DEVELOPER_GUIDE.md) |
| E2E spec を書く | [../../e2e/README.md](../../e2e/README.md) と [developer/E2E_LESSONS_LEARNED.md](../developer/E2E_LESSONS_LEARNED.md) (**新 spec 書く前に必読**) |

---

## 5. つまづいたら

| 症状 | 参照先 |
|---|---|
| CI で E2E テストが失敗した | [developer/E2E_LESSONS_LEARNED.md](../developer/E2E_LESSONS_LEARNED.md) の罠パターン集 + [developer/DEVELOPER_GUIDE.md §9.7](../developer/DEVELOPER_GUIDE.md) の誤認ログ表 |
| migration を本番に適用したい | [administrator/OPERATION.md](../administrator/OPERATION.md) |
| 視覚回帰 baseline の再生成 | [developer/DEVELOPER_GUIDE.md §9.6](../developer/DEVELOPER_GUIDE.md) |
| コミット時に hook でブロックされた | 危険 API / 機密情報の誤混入を検知中。`.claude/hooks/` 配下を確認して修正 |
| Claude Code の使い方 | [../../CLAUDE.md](../../CLAUDE.md) |

---

## 6. 次に読むべきドキュメント

本書を一通り読んで環境構築が済んだら、以下を **必要に応じて** 参照してください:

- [docs/README.md](../README.md) — 全ドキュメント索引 (各役割別にどこを見るか)
- [developer/DEVELOPER_GUIDE.md](../developer/DEVELOPER_GUIDE.md) — 改修の実務手順 (長いので必要な章だけ)
- [developer/DESIGN.md](../developer/DESIGN.md) — 設計原則 §21.4 ゼロハードコーディング、§29 テーマシステムは特に重要
- [developer/TESTING_STRATEGY.md](../developer/TESTING_STRATEGY.md) — 自動 / 手動テストの役割分担

---

## 7. 質問・不明点

- バグを見つけた → [../../SECURITY.md](../../SECURITY.md) (脆弱性の場合) / GitHub Issues
- 仕様について迷った → [developer/REQUIREMENTS.md](../developer/REQUIREMENTS.md) + [developer/SPECIFICATION.md](../developer/SPECIFICATION.md) を先に確認、それでも不明なら Issue / レビュアに相談
- コードレビューの観点 → [../../CONTRIBUTING.md §5](../../CONTRIBUTING.md)

**Welcome to たすきば Knowledge Relay!**
