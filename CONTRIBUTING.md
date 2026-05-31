# コントリビューション規約 (CONTRIBUTING.md)

> 本書は本リポジトリへのコード変更に関わる人 (社内開発者・将来の引き継ぎ担当者・
> 外部コントリビュータ) 向けの規約と手順を記述します。
>
> 関連:
> - [README.md](./README.md) — プロジェクト概要
> - [docs/README.md](./docs/README.md) — ドキュメント索引 (役割別)
> - [docs/operations/develop/](./docs/operations/develop/) — 改修・追加・削除の実務手順
> - [docs/design/](./docs/design/) — 設計書 (ARCHITECTURE / DATA_MODEL / API_DESIGN / SECURITY / INFRASTRUCTURE 等に分割)
> - [docs/operations/](./docs/operations/) — 運用・デプロイ手順

---

## 目次

1. [コミット前チェックリスト](#1-コミット前チェックリスト)
2. [ブランチ運用](#2-ブランチ運用)
3. [コミットメッセージ規約](#3-コミットメッセージ規約)
4. [Pull Request 作成規約](#4-pull-request-作成規約)
5. [コードレビューチェックリスト](#5-コードレビューチェックリスト)
6. [禁止事項](#6-禁止事項)
7. [困ったときの参照先](#7-困ったときの参照先)

---

## 1. コミット前チェックリスト

すべてのコミット前に以下を必ず確認してください ([docs/operations/develop/TEST_LINT_BUILD.md](./docs/operations/develop/TEST_LINT_BUILD.md) 参照)。

```bash
pnpm lint        # 静的解析エラーゼロ
pnpm test        # 全テスト pass (現在 388 件)
pnpm build       # ビルド成功 (型エラー検出含む)
```

**3 つすべて成功しないとコミット禁止**。CI (`.github/workflows/ci.yml`) でも自動検証されますが、ローカルで先に確認することで PR レビューサイクルが高速になります。

### コミット内容のチェック

- [ ] **設計原則に違反していないか**: 業務的意味を持つ値を `src/config/` 経由でなくハードコードしていないか ([docs/design/ARCHITECTURE.md](./docs/design/ARCHITECTURE.md) のハードコード禁止セクション参照)
- [ ] **テストコードを追加・更新したか**: 機能追加時はテスト必須
- [ ] **ドキュメントを更新したか**: 仕様変更時は [docs/specification/](./docs/specification/) / [docs/design/](./docs/design/) / [docs/operations/](./docs/operations/) / [docs/operations/develop/](./docs/operations/develop/) の該当ファイル
- [ ] **横展開漏れがないか**: 同じパターンが他ファイルに残っていないか `grep` で確認
- [ ] **機密情報を含めていないか**: `.env` 値 / API キー / パスワード / トークンを直書きしていない
- [ ] **危険な動的コード実行 API を使っていないか**: ブロックフック (`.claude/hooks/block-dangerous-edit.sh`) で検知される系統 (具体的なリストは同フックを参照)

---

## 2. ブランチ運用

### 2.1 ブランチ命名規約

| 用途 | プレフィックス | 例 |
|---|---|---|
| 機能追加 | `feat/` | `feat/pr82-add-export-csv` |
| バグ修正 | `fix/` | `fix/pr82-dark-mode-select-contrast` |
| ドキュメント | `docs/` | `docs/pr82-developer-guide` |
| リファクタ (機能影響なし) | `refactor/` | `refactor/pr82-extract-validation-constants` |
| 緊急修正 | `hotfix/` | `hotfix/pr82-database-connection` |

PR 番号は事前に予約しておくと整理しやすい (例: `feat/pr85-...`)。

### 2.2 保護されたブランチ

以下のブランチへの直接コミットは禁止:

- `main`
- `master`
- `develop`
- `release/*`
- `hotfix/*` (例外的にレビュー後マージ)

---

## 3. コミットメッセージ規約

### 3.1 基本形式

```
件名 (1 行、命令形ではなく事実記述)

本文 (任意、複数段落可)
  - 何を変更したか
  - なぜ変更したか (背景)
  - 影響範囲 (触ったテーブル / 画面 / API)

Co-Authored-By: ... (AI ペアプロ時のみ)
```

### 3.2 件名のスタイル

良い例:
```
プロジェクト一覧画面に状態フィルタを追加 (PR #82)
ログイン失敗ロック回数を 5 → 3 に変更 (セキュリティ強化)
docs/operations/develop/HOW_TO_ADD_FEATURES.md を更新 (i18n 移行手順を追記)
```

悪い例:
```
update                  # 何を update したか不明
fix bug                 # どのバグか不明
WIP                     # コミット対象が曖昧
[REVIEW] xxx feature    # マージ前提の文脈がコミットに残ってはいけない
```

### 3.3 単位

- **テストコードの追加・修正を伴わないソースコード変更はコミット禁止** (CLAUDE.md コミットルール)
- 1 コミットには関連する変更のみを含める (機能 A の修正と機能 B の修正は分ける)
- ドキュメントのみの変更は別コミット (差分が読みやすくなる)

---

## 4. Pull Request 作成規約

### 4.1 PR タイトル

ブランチ名と同様の趣旨で、何を実現する PR かを 1 行で表現:

```
プロジェクト一覧画面に状態フィルタを追加 (PR #82)
```

### 4.2 PR 本文テンプレート

```markdown
## Summary

(変更の目的と概要を 2-3 文で)

## 変更内容

(箇条書きで主要な変更点)

- ファイルAを変更し、~~ するように更新
- ファイルBを新規作成し、~~ を実装

## 関連ドキュメント

- DESIGN.md §X.Y を更新
- SPECIFICATION.md §A.B に新機能を追記

## Test plan

- [ ] `pnpm lint` clean
- [ ] `pnpm test` all pass
- [ ] `pnpm build` 成功
- [ ] 手動テスト: 新機能を画面 X で操作し、期待通りに動作することを確認
```

### 4.3 マージ条件

以下をすべて満たすまでマージ禁止:

1. **CI が全 pass**: `.github/workflows/ci.yml` (lint / test / build) すべて成功
2. **セキュリティスキャン pass**: `.github/workflows/security.yml` (gitleaks / pnpm audit / CodeQL)
3. **コードレビュー** (チームに 2 人以上いる場合は別メンバーの承認 1 件以上)
4. **DB スキーマ変更を含む場合**: マージ前に Supabase で migration を手動実行 ([docs/operations/develop/DB_MIGRATION_PROCEDURE.md](./docs/operations/develop/DB_MIGRATION_PROCEDURE.md))
5. **視覚回帰**: UI 変更を含む場合は Netlify Deploy Preview で目視確認 (`https://deploy-preview-NNN--tasukiba.netlify.app`)

### 4.4 マージ方式

- **デフォルト**: Squash merge (1 PR = 1 コミット)
- **大規模 PR で履歴を残したい場合**: Merge commit
- **小型修正のみ**: Rebase merge (履歴を直線化)

#### ★最重要★ Squash merge 時の `[skip ci]` / `[skip netlify]` キーワード扱い (= 本番 deploy 事故防止)

> **背景**: 2026-05-22 に PR #425 / #426 のマージで Netlify Production deploy が 3 連続 skip され、**sticky header / signup 3 層判定 (severity-1)** が約 1 日本番未反映となる事故が発生。原因はローカル commit message に書かれた `[skip netlify]` が squash merge で main commit に持ち越され、Netlify が main の push commit を skip した。詳細: [KDD §5.X+114](./docs/knowledge/KDD_PATTERNS.md) / [DEPLOYMENT.md §3.5](./docs/operations/develop/DEPLOYMENT.md)

##### 開発者ルール

- **ローカル commit message には `[skip ci]` / `[skip netlify]` を絶対に書かない**
- Deploy Preview を skip したい場合は **PR タイトル末尾にだけ書く** (`gh pr edit <N> --title "...[skip netlify]"`)
- commit message body 内に doc 引用として `[skip ci]` / `[skip netlify]` 等を書くのも禁止 (生文字列が GitHub Actions / Netlify に検出される) — 必要なら鉤括弧 `「skip ci」` / バックスラッシュエスケープ `\[skip ci\]` で記述

##### reviewer / maintainer ルール (Squash merge 直前に必ず実施)

GitHub の **「Confirm squash and merge」** 画面で:

1. **commit title 入力欄** から `[skip ci]` / `[ci skip]` / `[no ci]` / `[skip actions]` / `[actions skip]` / `[skip netlify]` を **意図的に残す場合を除いて削除**
2. **commit body 入力欄** からも上記キーワードの **生文字列** を **全件削除** (= 元の PR description / 各 commit message の自動連結で残りがち)
   - 例: 「`commit メッセージに [skip ci] を入れる場合は...`」のような doc 引用文も対象 (= GitHub Actions / Netlify は markdown を解さず生文字列マッチする)
3. マージ実行
4. **マージ後 1-2 分以内に Netlify Dashboard → Deploys タブで該当 commit の Production deploy が `Building` / `Ready` になっていることを確認**
   - `Skipped` になっていたら手順 1-2 の漏れ → 即時「Trigger deploy → Deploy site」で復旧 (過去分の変更がまとめて反映される)

##### 「Skip キーワードを意図的に残す」ケース (= 本番反映不要を確信している場合)

- docs-only PR で credits を温存したい場合: `scripts/netlify-ignore.sh` の path-based skip が自動で発動するため、`[skip netlify]` 付与は **冗長 (= 書かない方が安全)**
- `[skip ci]` を main commit に残す: GitHub Actions すべてが skip される (= レビュー後の post-merge regression 検知も走らない) ため **原則禁止**。例外的に許可するのは「リポジトリ整理コミット」等で reviewer が責任を取る場合のみ

---

## 5. コードレビューチェックリスト

レビュー時は以下を確認してください。AI 駆動時代に並行 agent (auth / injection / xss / secret / dependency / performance / label) が担当していた観点を、人間レビュー用の単一チェックリストに統合しています。

> 該当しない項目はスキップして構いません (純粋なドキュメント PR では 5.1-5.10 の大半は不要)。

### 5.1 横展開チェック (最重要)

- [ ] 修正した問題と同じパターンが他ファイルに残っていないか (`grep` で全検索)
- [ ] マスタデータの追加時、UI / バリデータ / DB すべてに反映されているか
- [ ] テーマ追加時、`THEMES` / `THEME_DEFINITIONS` / `THEME_COLOR_SCHEMES` 3 ファイル全てに追記されているか
- [ ] 価格定数・閾値・enum 等の変更時、`toLocaleString` 表示文字列 / 自然文 / Playwright spec assertions も全て更新済 (生値 grep だけだと取りこぼす)

### 5.2 認可・テナント境界 (severity-1 リスク領域)

旧 auth-reviewer agent の観点を統合。詳細は [ADR-0001](./docs/adr/0001-multitenant-foundation.md) / [ADR-0005](./docs/adr/0005-rbac-two-stage-tenant-authorization.md) / [ADR-0024](./docs/adr/0024-explicit-tenant-id-no-db-default.md)。

- [ ] **テナント越境防止**: 一覧系サービスに `viewerTenantId` を必須引数化し、`where.tenantId` フィルタを強制
- [ ] **詳細系認可**: `getById(id, viewerTenantId)` 形式で where に `tenantId` を含める
- [ ] **API ルート認可**: `getAuthenticatedUser` + `checkProjectPermission` / `requireAdmin` を最初の行で実施
- [ ] **super_admin の例外パス**: テナント境界バイパス時は必ず監査ログを残す
- [ ] **session 改ざんへの耐性**: ロールや tenantId をクライアント信用 (JWT claim だけで判定) していない
- [ ] **監査ログ記録**: CREATE / UPDATE / DELETE / 認証イベント時に `recordAuditLog` / `recordAuthEvent`
- [ ] **★create 時の tenantId 明示** (ADR-0024 / 2026-05-28 severity-1 fix 起因): `prisma.X.create({ data: { tenantId, ... } })` の `data` に **必ず tenantId を渡す**。schema 側は `@default(dbgenerated)` を持たない (= 未指定なら NOT NULL 違反で loud fail する設計)

### 5.2.1 schema 変更 PR の検証範囲拡張 (5 軸網羅)

`prisma/schema.prisma` の `tenantId` 関連 (NOT NULL / DEFAULT / 型) を変更する PR、特に **DB DEFAULT 撤去 / 追加 / 変更** を含む PR では、以下の **5 軸すべて** をフルスキャンする (ADR-0024 / KDD §5.X+170 で確立した観点):

| 軸 | 対象 | grep パターン例 |
|---|---|---|
| 1. 本番コード | `src/` の Prisma 呼び出し | `prisma\.(user|customer|project|riskIssue|...)\.create\(` |
| 2. seed | `prisma/seed*.ts` の Prisma 呼び出し | 同上 |
| 3. 運用スクリプト | `scripts/*.ts` の Prisma / pg 呼び出し | `prisma\.X\.create` および `pool\.query.*INSERT` |
| 4. **E2E fixture の raw SQL** | `e2e/fixtures/*.ts` / `e2e/specs/*.ts` | `INSERT INTO\s+(users|customers|projects|...)\s*\(` |
| 5. migration 内 INSERT | `prisma/migrations/*/migration.sql` | `INSERT INTO` (主に INSERT SELECT 系 seed migration) |

**重要**: 軸 4 (E2E fixture の raw SQL) は `prisma.X.create` grep に引っかからず、Round 1 の PR fix/tenant-id-default-removal で見逃して CI 全滅した実例あり ([post-mortem](./docs/operations/post-mortems/2026-05-28-tenant-id-default-silent-fallthrough.md))。**必ず軸 4 まで含めること**。

### 5.3 入力検証・SQL 安全性 (旧 injection-reviewer)

- [ ] **入力バリデーション**: ユーザ入力は Zod スキーマで型・長さ・形式を検証
- [ ] **生 SQL 不使用**: Prisma クエリビルダ経由のみ。`$queryRawUnsafe` にユーザ入力を直接渡していない
- [ ] **`$queryRaw` 使用時はテンプレートリテラル**: パラメータバインディングを使い、文字列結合していない
- [ ] **LLM プロンプトインジェクション対策**: ユーザ入力は `<user_input>` 等の XML タグで明示的に分離、LLM 出力は Zod で構造化検証
- [ ] **LLM コンテキストに他ユーザ・admin・システム秘匿情報を含めない**

### 5.4 XSS・出力エスケープ (旧 xss-reviewer)

- [ ] **生 HTML 注入 API 不使用** (React の dSI 系 / `v-html` / `innerHTML` 系)。やむを得ない場合は DOMPurify 等で sanitize し、理由をコメントで残す
- [ ] **`<a href>` の URL バリデーション**: ユーザ入力 URL に `javascript:` / `data:` を許容していない
- [ ] **HTML 注入の経路**: Markdown レンダラ・SVG・テンプレート文字列でユーザ入力を生展開していない
- [ ] **LLM 出力の表示**: React の自動エスケープに依存し、生 HTML 系 API で表示していない

### 5.5 機密情報の取扱い (旧 secret-reviewer)

- [ ] **API キー / 秘密鍵のハードコード無し** (gitleaks が CI で検知するが事前確認)
- [ ] **`.env` / `*.pem` / `*.key` / `credentials.*` をコミットしていない** (`.gitignore` 設定済、`.claude/hooks/block-dangerous-edit.sh` が警戒)
- [ ] **ログ出力時のシークレット redaction**: `recordError` / `console.error` で API キー・JWT・パスワード相当の文字列をマスク済
- [ ] **エラーメッセージから内部情報を露呈していない**: stack trace やクエリ文字列がそのままユーザに返らない (`system_error_logs` に記録し画面は固定文言)

### 5.6 パフォーマンス (旧 performance-reviewer)

memory: `feedback_perf_antipatterns` の 5 パターンを変更時に自問する。

- [ ] **N+1 クエリ無し**: ループ内 DB クエリは `Promise.all` または JOIN / `include` に集約
- [ ] **重複 findMany 無し**: 同じデータを複数回 fetch していない (上流で 1 回取って渡す)
- [ ] **`limit` 乖離無し**: ページネーション + count + offset のロジック整合
- [ ] **React 再レンダー**: `React.memo` / `useCallback` / `useMemo` を必要箇所に適用
- [ ] **Provider watch の局所化**: 必要な field のみ subscribe (Context 全体を見ない)
- [ ] **eager fetch 回避**: 詳細画面で一覧用の集計を毎回取らない
- [ ] **O(N×M) 背景処理**: cron バッチや bulk 処理で計算量が暴発しないか確認

### 5.7 依存パッケージ (旧 dependency-reviewer)

- [ ] **新規 npm 追加時の事前確認 4 点** (KDD §5.67):
  - `npm view <pkg> time` で最終更新日 (1 年以内が望ましい)
  - GitHub リポジトリの Issues / Releases 活発度
  - `pnpm audit` / `snyk` で脆弱性事前確認
  - OpenSSF Scorecard >= 3.0
- [ ] **禁止リスト**: `xlsx` (npm 版、メンテ放棄)、SheetJS Pro 以外の Excel 系 → 代替: `csv-parse` / `exceljs`
- [ ] **Dependabot PR**: CI 自動更新 PR にマージブロッカーがないか確認

### 5.8 i18n・ラベル整合 (旧 label-checker)

memory: `feedback_no_hardcoding`。

- [ ] **UI 文字列のハードコード無し**: コンポーネント / ページに日本語文字列を直書きしていない
- [ ] **ラベル定数は `src/labels/` に集約** (将来の i18n 対応のため)
- [ ] **エラーメッセージ・プレースホルダ・ボタン文言も対象**

### 5.9 テスト整合性

- [ ] 変更箇所にテストが追加されているか (memory: `feedback_test_rule` テストコード必須)
- [ ] テストコードに旧文言の残留がないか (リネーム後の取りこぼし防止)
- [ ] テスト数の増減が変更内容と整合
- [ ] **E2E カバレッジ**: 新規 `page.tsx` / `route.ts` 追加時は `docs/test/E2E_COVERAGE.md` に追記、`pnpm e2e:coverage-check` で gap 検知 (CI でも強制)
- [ ] テスト実行時間が極端に増えていない

### 5.10 ドキュメント更新

変更内容に応じて以下を更新:

- [ ] [docs/business/](./docs/business/) — 業務ロジック (プロジェクトライフサイクル / 課金 / ロール / MVP スコープ)
- [ ] [docs/specification/](./docs/specification/) — 画面仕様 / 権限マトリクス / UI 制御ルール
- [ ] [docs/design/](./docs/design/) — アーキテクチャ / データモデル / API / セキュリティ / インフラ / UI パターン / 提案エンジン
- [ ] [docs/operations/](./docs/operations/) — デプロイ / DB マイグレーション / 障害対応 / Cron / 環境変数
- [ ] [docs/operations/develop/](./docs/operations/develop/) — 機能追加 / テスト lint build / コミット & デプロイ
- [ ] [docs/test/](./docs/test/) — テスト戦略 / E2E カバレッジ / 教訓
- [ ] [docs/security/](./docs/security/) — 脅威モデル / セキュリティタスク
- [ ] [docs/adr/](./docs/adr/) — 後戻りコストが高い設計判断を伴う場合は新規 ADR 追加

---

## 6. 禁止事項

### 6.1 コード上の禁止

- ❌ **業務的意味を持つ値のハードコード** ([docs/design/ARCHITECTURE.md](./docs/design/ARCHITECTURE.md))
  - 色: `bg-gray-50` 等の Tailwind パレット → semantic token (`bg-muted` 等) を使う
  - 文字数上限: `maxLength={100}` 直書き → `src/config/validation.ts` の定数を使う
  - 画面遷移パス: `redirect('/login')` 直書き → `src/config/app-routes.ts` の定数を使う
  - 認証定数: bcrypt cost = 12 直書き → `src/config/security.ts` の定数を使う
- ❌ **危険な動的コード実行 API**: ブロックフックで検知される系統 (`.claude/hooks/block-dangerous-edit.sh` 参照)
- ❌ **生 SQL の動的構築**: Prisma の `$queryRawUnsafe` にユーザ入力を直接渡すパターン (SQL インジェクション源)
- ❌ **`console.log` のコミット**: デバッグ用は削除してからコミット
- ❌ **コメントアウトされた死骸コード**: 不要なら git history に任せる

### 6.2 Git 運用上の禁止

- ❌ **`main` への直接コミット**: 必ず PR 経由
- ❌ **`--no-verify` でのコミット**: pre-commit hook 回避禁止
- ❌ **force push to main/master**: 共有ブランチの履歴改ざん禁止
- ❌ **機密ファイルのコミット**: `.env` / `*.pem` / `*.key` / `credentials.*` / `secrets.*` (.gitignore 設定済)
- ❌ **大規模リファクタと機能変更を同 PR**: レビュー困難になるため分離

---

## 7. 困ったときの参照先

| 困りごと | 参照先 |
|---|---|
| 開発環境を立ち上げたい | [ONBOARDING.md](./ONBOARDING.md)(クイックスタート)または [docs/operations/develop/SETUP_LOCAL.md](./docs/operations/develop/SETUP_LOCAL.md)(詳細手順・トラブルシューティング) |
| 新機能を追加したい | [docs/operations/develop/HOW_TO_ADD_FEATURES.md](./docs/operations/develop/HOW_TO_ADD_FEATURES.md) |
| テーマを追加したい | [docs/operations/develop/HOW_TO_ADD_FEATURES.md](./docs/operations/develop/HOW_TO_ADD_FEATURES.md) |
| DB スキーマを変更したい | [docs/operations/develop/HOW_TO_ADD_FEATURES.md](./docs/operations/develop/HOW_TO_ADD_FEATURES.md) / [docs/operations/develop/DB_MIGRATION_PROCEDURE.md](./docs/operations/develop/DB_MIGRATION_PROCEDURE.md) |
| 設計の意図を知りたい | [docs/design/](./docs/design/) (ARCHITECTURE / DATA_MODEL / API_DESIGN / SECURITY / INFRASTRUCTURE / SUGGESTION_ENGINE / UI_PATTERNS に分割) |
| デプロイ失敗時の対応 | [docs/operations/develop/DEPLOYMENT.md](./docs/operations/develop/DEPLOYMENT.md) / [docs/operations/operate/INCIDENT_RESPONSE.md](./docs/operations/operate/INCIDENT_RESPONSE.md) |
| **新バージョンをリリースしたい (CHANGELOG / お知らせ / version bump 等)** | **[docs/operations/develop/RELEASE_PROCEDURE.md](./docs/operations/develop/RELEASE_PROCEDURE.md)** |
| 過去の議論の経緯 | `git log` / GitHub 過去 PR |
| 過去の罠・教訓 | [docs/knowledge/](./docs/knowledge/) / [docs/test/E2E_LESSONS.md](./docs/test/E2E_LESSONS.md) |

---

## 更新履歴

| 日付 | 内容 |
|---|---|
| 2026-04-21 | 初版作成 (PR #82) |
