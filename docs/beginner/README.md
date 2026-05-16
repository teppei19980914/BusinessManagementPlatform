# 開発者オンボーディング — 深掘り解説

> **本書の位置づけ**:
> リポジトリトップの [`ONBOARDING.md`](../../ONBOARDING.md) が「環境構築から PR 作成まで」のクイックスタート(コマンドレベル)を提供します。
> 本書は **その背景説明と深掘り** を行うガイドです — コードベースの構造 / 設計原則 / 改修パターン / つまづきポイント。
>
> 初めて触る方はまず [`ONBOARDING.md`](../../ONBOARDING.md) を完了し、その後で本書の該当セクションを参照してください。

---

## 0. 前提

本プロジェクトは以下の構成です。

- **フロントエンド + バックエンド**: Next.js 16 (App Router) / React 19 / TypeScript
- **DB**: PostgreSQL 16 (Prisma 7 + @prisma/adapter-pg)
- **認証**: NextAuth.js (Auth.js) v5
- **テスト**: Vitest (ユニット) + Playwright (E2E / 視覚回帰)
- **デプロイ**: Vercel + Supabase

**用語** (頻出のみ、詳細は [docs/business/GLOSSARY.md](../business/GLOSSARY.md)):

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

## 1. 開発環境の構築

環境構築のコマンドレベル手順は [`ONBOARDING.md`](../../ONBOARDING.md) §1〜§5 を参照してください。
本セクションでは「**なぜそうするか**」の背景説明を補足します。

### 1.1 ツール選定の理由

- **Node.js 22 LTS**: Next.js 16 の動作要件 + LTS による長期サポート
- **pnpm**: モノレポ機能 + node_modules の容量効率(2-3 倍効率)
- **Docker Desktop**: ローカル PostgreSQL 用。本番 Supabase と分離してデータ汚染を防ぐ
- **GitHub CLI**: `gh pr create` で PR テンプレート自動挿入が便利

### 1.2 環境変数の意味

`ONBOARDING.md §3` で設定する変数の役割:

| キー | 意味 / 注意点 |
|---|---|
| `DATABASE_URL` / `DIRECT_URL` | Prisma が 2 系統を持つ理由は [docs/operations/ENV_VARS.md](../operations/ENV_VARS.md) §「DB 接続 URL の二重化」を参照。Pooler 経由と直結を使い分ける |
| `NEXTAUTH_SECRET` | NextAuth の JWT 署名鍵。32 バイト以上必須。**漏洩 = 全ユーザのセッションを偽造可能** なので扱い注意 |
| `INITIAL_ADMIN_EMAIL` / `INITIAL_ADMIN_PASSWORD` | `pnpm db:seed` でこの値の管理者ユーザが作成される。本番運用前に必ず変更 |
| `MAIL_PROVIDER` | 開発は `console`(コンソールに出力)、本番は `brevo` 等 |

詳細: [docs/operations/ENV_VARS.md](../operations/ENV_VARS.md)

### 1.3 `pnpm db:seed` が何をするか

`prisma/seed.ts` でパスワードポリシーを検証し、`.env` の `INITIAL_ADMIN_EMAIL` / `INITIAL_ADMIN_PASSWORD` で `systemRole='admin'` ユーザを作成します。**実行しないと誰もログインできない** ため必須。

リカバリーコード 10 個が標準出力に表示されるので、MFA リセット用に控えてください(二度と表示されません)。

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
| 1 | [business/MVP_SCOPE.md](../business/MVP_SCOPE.md) | 何を目指しているサービスか(MVP 範囲) |
| 2 | [specification/SCREENS.md](../specification/SCREENS.md) / [specification/PERMISSION_MATRIX.md](../specification/PERMISSION_MATRIX.md) | どの画面で何ができるか + 権限マトリクス |
| 3 | [design/ARCHITECTURE.md](../design/ARCHITECTURE.md) / [design/DATA_MODEL.md](../design/DATA_MODEL.md) | アーキテクチャ全体像とデータモデル |
| 4 | [developer-guide/HOW_TO_ADD_FEATURES.md](../developer-guide/HOW_TO_ADD_FEATURES.md) | 改修の実務手順 (テーマ追加 / マスタデータ追加 / 画面追加 / 既存改修 / DB 変更) |

段階的なリーディングパス (Day 1 / Week 1 / Month 1) は [docs/README.md](../README.md) を参照。

### 2.3 設計原則(ゼロハードコーディング)

**業務的意味を持つ値はハードコードせず、すべて `src/config/` に集約** します。例:
- ステータス列挙 (`TASK_STATUSES`) → `src/config/master-data.ts`
- ログイン失敗ロック回数 → `src/config/security.ts`
- 文字数上限 → `src/config/validation.ts`
- テーマ色 → `src/config/theme-definitions.ts`

詳細は [developer-guide/REFERENCE.md](../developer-guide/REFERENCE.md)(設計原則のリマインダ) と [design/ARCHITECTURE.md](../design/ARCHITECTURE.md) を参照。

---

## 3. 初めての開発 — 小さな改修を 1 件通してみる

実例: 「ログイン失敗許容回数を 5 回から 3 回に変更する」(= `src/config/security.ts` の 1 行変更)

### 3.1 ブランチを切る

```bash
git checkout main
git pull origin main
git checkout -b fix/login-failure-lock-threshold
```

ブランチ命名: [CONTRIBUTING.md §2](../../CONTRIBUTING.md) 参照。

### 3.2 コードを変更

`src/config/security.ts` を開き、`LOGIN_FAILURE_MAX` の値を編集します。

### 3.3 テストを追加・更新

本プロジェクトでは **テストコードを伴わない変更は禁止** です ([CLAUDE.md](../../CLAUDE.md) / [CONTRIBUTING.md](../../CONTRIBUTING.md))。定数変更なら:

- 既存のログイン失敗テスト (`src/services/auth-event.service.test.ts` 等) が新しい値で通るか確認
- 閾値 3 回に依存するエッジケースのテストを追加

### 3.4 ローカル検証

コミット前に必ず以下が成功することを確認:

```bash
pnpm lint              # ESLint: 静的解析エラーゼロ
pnpm tsc --noEmit      # TypeScript 型チェック
pnpm test              # Vitest: 全ユニットテスト pass
pnpm build             # 本番ビルド成功
```

新規 `page.tsx` / `route.ts` を追加した場合は追加で:

```bash
pnpm e2e:coverage-check
```

E2E テスト (Playwright) はオプション (重いので PR 時に CI で走る):

```bash
pnpm test:e2e          # CLI 実行
pnpm test:e2e:ui       # Playwright UI モード (推奨、対話的デバッグ)
```

詳細は [developer-guide/TEST_LINT_BUILD.md](../developer-guide/TEST_LINT_BUILD.md)。

### 3.5 コミット前のチェック ([CONTRIBUTING.md §5](../../CONTRIBUTING.md) より)

10 項目のレビュー観点チェックリストを自己レビュー:

1. 横展開(同一パターンが他ファイルに残っていないか grep)
2. 認可・テナント境界(severity-1 リスク領域)
3. 入力検証・SQL 安全性
4. XSS・出力エスケープ
5. 機密情報の取扱い
6. パフォーマンス(N+1 / 重複 findMany / limit 乖離等)
7. 依存パッケージ(新規 npm 追加時の事前審査 4 点)
8. i18n・ラベル整合
9. テスト整合性
10. ドキュメント更新

詳細: [CONTRIBUTING.md §5](../../CONTRIBUTING.md)

### 3.6 コミット

コミットメッセージは **変更内容を端的に**:

```bash
git add src/config/security.ts <テストファイル>
git commit -m "ログイン失敗ロック閾値を 5 → 3 回に変更"
```

禁止事項: **`main` / `master` / `develop` / `release/*` / `hotfix/*` への直接コミット禁止** ([CONTRIBUTING.md §2.2](../../CONTRIBUTING.md))。

### 3.7 プッシュ + PR 作成

```bash
git push -u origin <your-branch-name>
gh pr create --base main --title "ログイン失敗ロック閾値を 5 → 3 回に変更" --body "<変更内容と検証結果>"
```

PR 本文の書き方は [`.github/PULL_REQUEST_TEMPLATE.md`](../../.github/PULL_REQUEST_TEMPLATE.md) のテンプレートに従う。

### 3.8 レビュー → マージ

- CI 全 green になるまで待つ(ci.yml + e2e.yml + security.yml + dependency-review.yml + docs-link-check.yml)
- レビュアからのコメントに応答 → 修正 → 再 push
- approve 後、GitHub UI で **Squash and merge** が推奨

CI の内訳は [`ONBOARDING.md` §7.2](../../ONBOARDING.md) を参照。

---

## 4. よくある改修パターン (詳細リンク)

上記の「定数 1 つ変える」以外の典型パターン:

| やりたいこと | 参照先 |
|---|---|
| テーマカラーの追加・変更 | [developer-guide/HOW_TO_ADD_FEATURES.md](../developer-guide/HOW_TO_ADD_FEATURES.md) §「テーマ追加」 |
| マスタデータ (ステータス等) の追加 | [developer-guide/HOW_TO_ADD_FEATURES.md](../developer-guide/HOW_TO_ADD_FEATURES.md) §「マスタデータ追加」 |
| 新しい画面・機能を追加 | [developer-guide/HOW_TO_ADD_FEATURES.md](../developer-guide/HOW_TO_ADD_FEATURES.md) §「画面追加」 |
| 既存機能の改修 | [developer-guide/HOW_TO_ADD_FEATURES.md](../developer-guide/HOW_TO_ADD_FEATURES.md) |
| DB スキーマ変更 | [operations/DB_MIGRATION_PROCEDURE.md](../operations/DB_MIGRATION_PROCEDURE.md) |
| UI ラベル (i18n) 追加 | [developer-guide/HOW_TO_ADD_FEATURES.md](../developer-guide/HOW_TO_ADD_FEATURES.md) §「i18n」 |
| シードデータの更新 | [developer-guide/SEED_DATA_MAINTENANCE.md](../developer-guide/SEED_DATA_MAINTENANCE.md) |
| E2E spec を書く | [../../e2e/README.md](../../e2e/README.md) と [test/E2E_LESSONS.md](../test/E2E_LESSONS.md) (**新 spec 書く前に必読**) |

---

## 5. つまづいたら

| 症状 | 参照先 |
|---|---|
| 環境構築(DB 接続 / migration / dev サーバ等) | [operations/SETUP_LOCAL.md](../operations/SETUP_LOCAL.md) |
| CI で E2E テストが失敗した | [test/E2E_LESSONS.md](../test/E2E_LESSONS.md)(罠パターン集) |
| migration を本番に適用したい | [operations/DB_MIGRATION_PROCEDURE.md](../operations/DB_MIGRATION_PROCEDURE.md) |
| 視覚回帰 baseline の再生成 | [test/VISUAL_REGRESSION_CHECKLIST.md](../test/VISUAL_REGRESSION_CHECKLIST.md) |
| コミット時に hook でブロックされた | 危険 API / 機密情報の誤混入を検知中。`.claude/hooks/block-dangerous-edit.sh` を確認 |
| Claude Code の使い方 | [../../CLAUDE.md](../../CLAUDE.md)(緊急時のみ利用) |
| 障害対応 | [operations/INCIDENT_RESPONSE.md](../operations/INCIDENT_RESPONSE.md) |

---

## 6. 次に読むべきドキュメント

本書を一通り読んで環境構築が済んだら、以下を **必要に応じて** 参照してください:

- [docs/README.md](../README.md) — 全ドキュメント索引 (リーディングパス Day 1 / Week 1 / Month 1)
- [developer-guide/HOW_TO_ADD_FEATURES.md](../developer-guide/HOW_TO_ADD_FEATURES.md) — 改修の実務手順
- [design/ARCHITECTURE.md](../design/ARCHITECTURE.md) / [design/DATA_MODEL.md](../design/DATA_MODEL.md) — アーキテクチャとデータモデル
- [design/SECURITY.md](../design/SECURITY.md) — セキュリティ設計と多層防御
- [adr/](../adr/) — 主要設計判断の根拠(ADR-0001〜0013)
- [test/STRATEGY.md](../test/STRATEGY.md) — 自動 / 手動テストの役割分担

---

## 7. 質問・不明点

- バグを見つけた → [../../SECURITY.md](../../SECURITY.md)(脆弱性の場合) / GitHub Issues
- 仕様について迷った → [business/MVP_SCOPE.md](../business/MVP_SCOPE.md) + [specification/SCREENS.md](../specification/SCREENS.md) を先に確認、それでも不明なら Issue / レビュアに相談
- コードレビューの観点 → [CONTRIBUTING.md §5](../../CONTRIBUTING.md)
- 顧客 FB の取り扱い → [operations/CUSTOMER_FEEDBACK_TRIAGE.md](../operations/CUSTOMER_FEEDBACK_TRIAGE.md)

**Welcome to たすきば Knowledge Relay!**
