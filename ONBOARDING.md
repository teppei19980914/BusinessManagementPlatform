# Onboarding — 環境構築から PR 作成まで

> 本書は **クローン直後の開発者** が、必要なツールをインストールし、ローカルで動作確認し、最初の PR を作成するまでを **1 ファイルで完結** させるガイドです。
>
> - **背景・思想**: [README.md](./README.md) / [docs/vision/README.md](./docs/vision/README.md)
> - **段階的な深掘り** (Day 1 / Week 1 / Month 1): [docs/README.md](./docs/README.md) のリーディングパス
> - **コードベースの歩き方** (主要ディレクトリ構造): [docs/design/ARCHITECTURE.md](./docs/design/ARCHITECTURE.md) §4

---

## 0. 全体像 (1 分)

```
[ ツールインストール ] → [ リポジトリ取得 ] → [ 環境変数設定 ] → [ DB セットアップ ]
                                                                    ↓
[ PR 作成 + CI 確認 ] ← [ コミット前チェック ] ← [ コード変更 ] ← [ 動作確認 (ログイン) ]
```

所要時間: 環境構築 ~30 分 + 動作確認 ~10 分 + 初回 PR ~30 分。

---

## 1. ツールのインストール

| ツール | バージョン | インストール先 | 確認 |
|---|---|---|---|
| Git | 2.30+ | https://git-scm.com/ | `git --version` |
| **Node.js** | **22 LTS** | https://nodejs.org/ (または `nvm install 22` / `volta install node@22`) | `node -v` |
| pnpm | 10+ | `corepack enable pnpm` または https://pnpm.io/installation | `pnpm -v` |
| Docker Desktop | 4.x+ | https://www.docker.com/products/docker-desktop/ | `docker -v` |
| GitHub CLI (`gh`) | 2.x | https://cli.github.com/ | `gh --version` |

> **Supabase クラウド接続を使う場合** は Docker は不要。詳細は §3。

インストール後、`gh` でログイン:

```bash
gh auth login    # ブラウザでログイン
```

---

## 2. リポジトリ取得 + 依存解決

```bash
git clone https://github.com/teppei19980914/BusinessManagementPlatform.git
cd BusinessManagementPlatform
pnpm install
```

---

## 3. 環境変数の設定

```bash
cp .env.example .env
```

`.env` を開き、**最低限以下を埋めて** ください。

### 3.1 NEXTAUTH_SECRET の生成 (必須)

```bash
openssl rand -base64 32
# → 出力された文字列を .env の NEXTAUTH_SECRET= に貼り付け
```

### 3.2 INITIAL_ADMIN_EMAIL / PASSWORD (必須)

`.env` に以下を設定:

```dotenv
INITIAL_ADMIN_EMAIL=your-email@example.com
INITIAL_ADMIN_PASSWORD=YourStr0ng!Password    # 10文字以上、英大文字・英小文字・数字・記号のうち3種以上
```

> このユーザで初回ログインするため、自分のメールアドレスを推奨。

### 3.3 DATABASE_URL (ローカル Docker の場合はデフォルトのまま)

`.env.example` のデフォルト値:
```dotenv
DATABASE_URL="postgresql://postgres:postgres@localhost:5433/tasukiba"
DIRECT_URL="postgresql://postgres:postgres@localhost:5433/tasukiba"
```

Supabase クラウド接続の場合は `.env.example` のコメント部分を参照して書き換え。

### 3.4 MAIL_PROVIDER (開発時はそのまま)

開発時は `MAIL_PROVIDER=console` のままで OK (メール送信内容がコンソールに出力される)。
本番では `brevo` 等に切り替え ([docs/operations/ENV_VARS.md](./docs/operations/ENV_VARS.md))。

---

## 4. DB のセットアップ

### 4.1 ローカル PostgreSQL を起動 (Docker)

```bash
docker compose up -d db
```

ポート 5433 で PostgreSQL 16 が起動します(`.env` の `DB_PORT=5433` と一致)。

> Supabase クラウド接続の場合は本ステップ不要。

### 4.2 Prisma Client 生成 + スキーマ適用

```bash
npx prisma generate          # @prisma/client を生成
npx prisma migrate dev       # 全マイグレーションを順次適用
```

### 4.3 初期管理者の作成 (必須)

```bash
pnpm db:seed
```

> このコマンドは `.env` の `INITIAL_ADMIN_EMAIL` / `INITIAL_ADMIN_PASSWORD` を使って **system_role=admin** ユーザを作成します。**実行しないと誰もログインできない** ので必ず実行してください。
>
> 実行時に **リカバリーコード 10 個が標準出力に表示** されます。MFA リセット用に **必ず控えて** ください(二度と表示されません)。

---

## 5. 開発サーバ起動 + 動作確認

```bash
pnpm dev
```

ブラウザで http://localhost:3000 を開きます。

### 5.1 初回ログインフロー

1. `.env` の `INITIAL_ADMIN_EMAIL` / `INITIAL_ADMIN_PASSWORD` でログイン
2. **強制パスワード変更画面** が表示される → 新しいパスワードを設定
3. **MFA 設定画面** が表示される(admin は MFA 必須):
   - Google Authenticator / 1Password / Microsoft Authenticator 等で QR コードを読み取り
   - 表示された 6 桁コードを入力して登録
4. ダッシュボードに到達 → 環境構築成功

### 5.2 動作確認チェックリスト

ダッシュボードから以下を確認:

- [ ] プロジェクト一覧画面を開ける(`/projects`)
- [ ] 新規プロジェクトを 1 件作成できる
- [ ] ナレッジを 1 件登録できる(`/knowledge`)
- [ ] super_admin ダッシュボードにアクセスできる(`/admin/super`)
- [ ] ログアウトして再ログインできる

詰まったら → [docs/operations/SETUP_LOCAL.md](./docs/operations/SETUP_LOCAL.md) のトラブルシューティング節へ。

---

## 6. 開発フロー (コード変更 → PR 作成)

### 6.1 ブランチを切る

```bash
git checkout main
git pull origin main
git checkout -b <type>/<short-description>
```

`<type>` は以下から選ぶ([CONTRIBUTING.md §2](./CONTRIBUTING.md)):

| プレフィックス | 用途 |
|---|---|
| `feat/` | 機能追加 |
| `fix/` | バグ修正 |
| `docs/` | ドキュメント |
| `refactor/` | リファクタリング(機能影響なし) |
| `hotfix/` | 緊急修正 |

例: `feat/add-export-csv`, `fix/login-redirect-loop`, `docs/update-glossary`

### 6.2 コード変更 + テスト追加

**ルール**: テストコードの追加・修正を伴わないソースコード変更は禁止([CLAUDE.md](./CLAUDE.md))。

開発中の有用コマンド:

| コマンド | 用途 |
|---|---|
| `pnpm dev` | 開発サーバ(ホットリロード) |
| `pnpm test:watch` | Vitest ウォッチモード |
| `pnpm lint` | ESLint 実行 |
| `pnpm tsc --noEmit` | TypeScript 型チェック |

### 6.3 コミット前チェック(必須)

```bash
pnpm lint && pnpm tsc --noEmit && pnpm test && pnpm build
```

**新規 `page.tsx` / `route.ts` を追加した場合は追加で**:

```bash
pnpm e2e:coverage-check    # E2E カバレッジマニフェストに登録漏れがないか検査
```

> このゲートを忘れて push すると CI が落ちます。

### 6.4 コミット

```bash
git add <files>
git commit -m "<変更内容を端的に>"
```

コミットメッセージの規約: [CONTRIBUTING.md §3](./CONTRIBUTING.md)

### 6.5 push

```bash
git push -u origin <your-branch-name>
```

> **`main` / `master` / `develop` / `release/*` / `hotfix/*` への直接 push は禁止** です。必ず別ブランチ → PR 経由でマージ。

---

## 7. PR 作成

### 7.1 gh コマンドで PR 作成

```bash
gh pr create --base main \
  --title "<PR タイトル: 何をする PR か 1 行で>" \
  --body "<本文(テンプレート自動挿入される)>"
```

`gh pr create` を引数なしで実行すると、エディタで [.github/PULL_REQUEST_TEMPLATE.md](./.github/PULL_REQUEST_TEMPLATE.md) のテンプレートが開きます。以下を埋めてください:

- 概要(1-3 行)
- 変更内容(箇条書き)
- 関連 Issue / 設計書
- 検証内容(lint / test / build / e2e:coverage-check / 動作確認チェック)
- **§5 コードレビュー観点 10 項目**(横展開 / 認可・テナント境界 / SQL / XSS / 機密情報 / パフォーマンス / 依存パッケージ / i18n / テスト / ドキュメント)

### 7.2 PR 作成後に自動実行される CI

PR を作成 / push すると以下の 6 つのワークフローが自動実行されます。**すべて green になるまでマージ不可**:

| Workflow | 内容 | 失敗時の対応 |
|---|---|---|
| **CI** | pnpm install → Prisma generate → ESLint → E2E カバレッジマニフェスト検査 → Vitest (+ coverage) → Next.js build | ローカルで `pnpm lint && pnpm tsc --noEmit && pnpm test && pnpm build` を再実行して再現 |
| **E2E** | Playwright で全 spec を実行 (PC + Mobile viewport の 2 project) | `pnpm test:e2e` でローカル再現、[docs/test/E2E_LESSONS.md](./docs/test/E2E_LESSONS.md) で類似事例検索 |
| **Security Scan** | gitleaks / pnpm audit / Semgrep / CodeQL / OSV-Scanner / Trivy / Security Score Gate (90/100) | [docs/security/README.md](./docs/security/README.md) §CI 統合を参照 |
| **Dependency Review** | 新規依存パッケージの脆弱性チェック | 新規 npm 追加時の事前審査 4 点([CONTRIBUTING.md §5.7](./CONTRIBUTING.md))を確認 |
| **Docs Link Check** | lychee で markdown 内のリンク切れを検知 | 移動・削除したファイルへの参照を grep で全件修正 |
| **Visual Regression** (UI 変更時) | Playwright `toHaveScreenshot` で pixel 比較 | `[gen-visual]` を commit message に含めると baseline が自動更新 |

### 7.3 マージ条件

1. CI 全 green
2. Security Scan score 90/100 以上
3. レビュー承認(チームに 2 人以上いる場合)
4. DB スキーマ変更を含む場合: マージ前に Supabase で migration を手動実行([docs/operations/DB_MIGRATION_PROCEDURE.md](./docs/operations/DB_MIGRATION_PROCEDURE.md))
5. UI 変更を含む場合: Vercel Preview Deployment で目視確認

### 7.4 マージ後

- Vercel が自動で production にデプロイ(数分)
- マージしたブランチはローカル / リモートとも削除

---

## 8. 次に読むもの (段階別)

新規参入者が **判断できるレベル** に到達するためのリーディングパスが [docs/README.md](./docs/README.md) にあります。

- **初日 (Day 1)** — 動かす / プロダクトを語れる ← **本書で完了**
- **1 週目 (Week 1)** — コード構造を把握 / 簡単な機能追加ができる
- **1 ヶ月目 (Month 1)** — 設計判断の背景を理解 / 複雑な変更を提案できる

各段階で読むべきドキュメントの **#・トピック・参照先** が 3 列表で示されています。**上から飛ばさず順に**読むのが推奨。

---

## 9. 困ったときの参照先

| 困りごと | 参照先 |
|---|---|
| 環境構築でハマった (DB 接続 / migration / dev サーバ) | [docs/operations/SETUP_LOCAL.md](./docs/operations/SETUP_LOCAL.md) |
| 環境変数の意味を知りたい | [docs/operations/ENV_VARS.md](./docs/operations/ENV_VARS.md) |
| 業務用語が分からない | [docs/business/GLOSSARY.md](./docs/business/GLOSSARY.md) |
| 「この機能は何のため?」「どのファイルを変更?」 | [docs/business/FEATURE_CATALOG.md](./docs/business/FEATURE_CATALOG.md) |
| 「なぜこの設計?」 | [docs/adr/](./docs/adr/README.md) (ADR 索引) |
| 過去の罠・教訓 | [docs/knowledge/](./docs/knowledge/) / [docs/test/E2E_LESSONS.md](./docs/test/E2E_LESSONS.md) |
| 障害対応 | [docs/operations/INCIDENT_RESPONSE.md](./docs/operations/INCIDENT_RESPONSE.md) |
| コミット / PR 規約の詳細 | [CONTRIBUTING.md](./CONTRIBUTING.md) |

---

## 10. 開発モード (現在)

本プロジェクトは **2026-06-01 以降、人間駆動開発** に移行しています。

- 平時の機能追加・保守は人間が IDE で直接実施
- Claude Code (`CLAUDE.md`) は **緊急時 / 重大障害時のみ** 利用
- AI 駆動時代の自動化 (auto-commit / session-start hook / KDD skill 等) は撤去済み

このモードで開発するための前提・規約は [CLAUDE.md](./CLAUDE.md) と [CONTRIBUTING.md](./CONTRIBUTING.md) を参照。
