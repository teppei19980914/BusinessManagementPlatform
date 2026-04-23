# コントリビューション規約 (CONTRIBUTING.md)

> 本書は本リポジトリへのコード変更に関わる人 (社内開発者・将来の引き継ぎ担当者・
> 外部コントリビュータ) 向けの規約と手順を記述します。
>
> 関連:
> - [README.md](./README.md) — プロジェクト概要
> - [docs/developer/DEVELOPER_GUIDE.md](./docs/developer/DEVELOPER_GUIDE.md) — 改修・追加・削除の実務手順
> - [docs/developer/DESIGN.md](./docs/developer/DESIGN.md) — 設計書 (情報源)
> - [docs/administrator/OPERATION.md](./docs/administrator/OPERATION.md) — 運用・デプロイ手順

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

すべてのコミット前に以下を必ず確認してください (`docs/developer/DEVELOPER_GUIDE.md` §9 参照)。

```bash
pnpm lint        # 静的解析エラーゼロ
pnpm test        # 全テスト pass (現在 388 件)
pnpm build       # ビルド成功 (型エラー検出含む)
```

**3 つすべて成功しないとコミット禁止**。CI (`.github/workflows/ci.yml`) でも自動検証されますが、ローカルで先に確認することで PR レビューサイクルが高速になります。

### コミット内容のチェック

- [ ] **設計原則 (DESIGN.md §21.4) に違反していないか**: 業務的意味を持つ値を `src/config/` 経由でなくハードコードしていないか
- [ ] **テストコードを追加・更新したか**: 機能追加時はテスト必須 (メモリ「テストコード必須ルール」)
- [ ] **ドキュメントを更新したか**: 仕様変更時は SPECIFICATION.md / DESIGN.md / OPERATION.md / DEVELOPER_GUIDE.md の該当箇所
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
| 当日作業ブランチ | `dev/YYYY-MM-DD` | `dev/2026-04-21` (Stop hook で自動生成) |

PR 番号は事前に予約しておくと整理しやすい (例: `feat/pr85-...`)。

### 2.2 保護されたブランチ

以下のブランチへの直接コミットは禁止 (`auto-commit.sh` が拒否):

- `main`
- `master`
- `develop`
- `release/*`
- `hotfix/*` (例外的にレビュー後マージ)

### 2.3 当日ブランチ

`dev/YYYY-MM-DD` は SessionStart hook が自動で切り替えます (`.claude/.git-automation-config` 有効時)。

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
docs/developer/DEVELOPER_GUIDE.md を更新 (i18n 移行手順を追記)
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
4. **DB スキーマ変更を含む場合**: マージ前に Supabase で migration を手動実行 (OPERATION.md §3)
5. **視覚回帰**: UI 変更を含む場合は Vercel Preview Deployment で目視確認

### 4.4 マージ方式

- **デフォルト**: Squash merge (1 PR = 1 コミット)
- **大規模 PR で履歴を残したい場合**: Merge commit
- **小型修正のみ**: Rebase merge (履歴を直線化)

---

## 5. コードレビューチェックリスト

レビュー時は以下を確認してください。

### 5.1 横展開チェック (最重要)

- [ ] 修正した問題と同じパターンが他ファイルに残っていないか (`grep` で全検索)
- [ ] マスタデータの追加時、UI / バリデータ / DB すべてに反映されているか
- [ ] テーマ追加時、`THEMES` / `THEME_DEFINITIONS` / `THEME_COLOR_SCHEMES` 3 ファイル全てに追記されているか

### 5.2 セキュリティチェック

- [ ] ユーザ入力のサニタイズ漏れなし (Zod バリデーション通過済か)
- [ ] 生 SQL の使用なし (Prisma 経由か `$queryRawUnsafe` 不使用か)
- [ ] 認可チェック実装あり (API ルートで `getAuthenticatedUser` + `checkProjectPermission` / `requireAdmin`)
- [ ] 監査ログ記録あり (CREATE / UPDATE / DELETE 時に `recordAuditLog`)

### 5.3 パフォーマンスチェック

- [ ] ループ内 DB クエリ (N+1) なし → `Promise.all` または JOIN を使う
- [ ] 不要な再レンダーなし → `React.memo` / `useCallback` / `useMemo` の検討
- [ ] 不要な Provider watch なし → 必要な部分だけ subscribe

### 5.4 テスト整合性

- [ ] 変更箇所にテストが追加されているか
- [ ] テストコードに旧文言の残留がないか (リネーム後の取りこぼし防止)
- [ ] テスト実行時間が極端に増えていないか

### 5.5 ドキュメント更新

- [ ] 変更内容に応じて以下が更新されているか:
  - `README.md` — プロジェクト概要 / セットアップ
  - `OPERATION.md` — 運用 / デプロイ / 障害対応
  - `REQUIREMENTS.md` — 要件定義
  - `SPECIFICATION.md` — 機能仕様
  - `DESIGN.md` — 設計
  - `DEVELOPER_GUIDE.md` — 改修手順

---

## 6. 禁止事項

### 6.1 コード上の禁止

- ❌ **業務的意味を持つ値のハードコード** (DESIGN.md §21.4)
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
- ❌ **`--no-verify` でのコミット**: pre-commit hook 回避禁止 (Stop hook の検査をバイパスしない)
- ❌ **force push to main/master**: 共有ブランチの履歴改ざん禁止
- ❌ **機密ファイルのコミット**: `.env` / `*.pem` / `*.key` / `credentials.*` / `secrets.*` (.gitignore 設定済)
- ❌ **大規模リファクタと機能変更を同 PR**: レビュー困難になるため分離

---

## 7. 困ったときの参照先

| 困りごと | 参照先 |
|---|---|
| 開発環境を立ち上げたい | [docs/beginner/README.md](./docs/beginner/README.md) または [docs/administrator/OPERATION.md](./docs/administrator/OPERATION.md) §2 |
| 新機能を追加したい | [docs/developer/DEVELOPER_GUIDE.md](./docs/developer/DEVELOPER_GUIDE.md) §4 |
| テーマを追加したい | [docs/developer/DEVELOPER_GUIDE.md](./docs/developer/DEVELOPER_GUIDE.md) §2 |
| DB スキーマを変更したい | [docs/developer/DEVELOPER_GUIDE.md](./docs/developer/DEVELOPER_GUIDE.md) §7 / [docs/administrator/OPERATION.md](./docs/administrator/OPERATION.md) §3 |
| 設計の意図を知りたい | [docs/developer/DESIGN.md](./docs/developer/DESIGN.md) (4500+ 行、章立てから検索) |
| デプロイ失敗時の対応 | [docs/administrator/OPERATION.md](./docs/administrator/OPERATION.md) §6 / §7 |
| 過去の議論の経緯 | `git log` / GitHub 過去 PR (#54〜) |

---

## 更新履歴

| 日付 | 内容 |
|---|---|
| 2026-04-21 | 初版作成 (PR #82) |
