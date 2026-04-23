# ドキュメント索引

本ディレクトリは、**たすきば Knowledge Relay** の開発・運用保守に関わる人が参照するドキュメントを役割別に整理したものです。

---

## 誰が何を読めば良いか

| あなたの立場 | まず読むディレクトリ |
|---|---|
| **このサービスを初めて触る開発者** | [beginner/](./beginner/README.md) — 環境構築から PR 作成までの一貫手順 |
| **開発者 (実装担当)** | [developer/](#developer--開発者向け) — 要件・仕様・設計・テスト・開発ガイド |
| **運用管理者 (デプロイ・障害対応担当)** | [administrator/](#administrator--運用管理者向け) — デプロイ / 環境変数 / migration / 障害対応 / リリース計画 |

---

## beginner/ — 初見開発者向け

| ファイル | 内容 |
|---|---|
| [beginner/README.md](./beginner/README.md) | **開発環境構築 → 初めての開発 → PR 作成までの一貫手順**。このサービスを初めて触る開発者はここから始めてください |

---

## developer/ — 開発者向け

### 仕様の三部作 (実装前に必読)

| ファイル | 内容 |
|---|---|
| [developer/REQUIREMENTS.md](./developer/REQUIREMENTS.md) | 要件定義 (なぜ必要か / 何を満たすか) |
| [developer/SPECIFICATION.md](./developer/SPECIFICATION.md) | 機能仕様 / 画面仕様 / 権限マトリクス / アカウントフロー |
| [developer/DESIGN.md](./developer/DESIGN.md) | アーキテクチャ / ER 図 / テーブル定義 / API / セキュリティ / インフラ |

### 開発実務

| ファイル | 内容 |
|---|---|
| [developer/DEVELOPER_GUIDE.md](./developer/DEVELOPER_GUIDE.md) | コード改修手順 / テスト実行 / 失敗調査 / spec 作成規約 |
| [developer/PLAN.md](./developer/PLAN.md) | 📌 **履歴資料**: MVP 構築 (2026-04-15 完了) の計画・実績記録。現行仕様は REQUIREMENTS / SPECIFICATION / DESIGN を参照 |

### テスト・品質

| ファイル | 内容 |
|---|---|
| [developer/TESTING_STRATEGY.md](./developer/TESTING_STRATEGY.md) | 自動テスト 3 層 + 手動テスト (UAT/a11y/クロスブラウザ等) の役割分担 |
| [developer/E2E_COVERAGE.md](./developer/E2E_COVERAGE.md) | 画面 / API の E2E カバレッジマニフェスト |
| [developer/E2E_LESSONS_LEARNED.md](./developer/E2E_LESSONS_LEARNED.md) | E2E 実装で得られた罠パターンと回避策 (PR #90 以降累積) |
| [developer/VISUAL_REGRESSION_CHECKLIST.md](./developer/VISUAL_REGRESSION_CHECKLIST.md) | 10 テーマ × 主要画面の目視確認チェックリスト (色トークン変更時) |

### ナレッジ・改修履歴

| ディレクトリ | 内容 |
|---|---|
| [developer/knowledge/](./developer/knowledge/) | 開発ナレッジ (KNW-001 設計文書の質と開発速度 / KNW-002 Next.js App Router のパフォーマンス最適化パターン) |
| [developer/performance/](./developer/performance/) | 2026-04-17 のパフォーマンス改修プロジェクトの分析レポート (3 段階の before/after 比較) |

---

## administrator/ — 運用管理者向け

| ファイル | 内容 |
|---|---|
| [administrator/OPERATION.md](./administrator/OPERATION.md) | 環境変数 / migration 適用 / デプロイ / 監視 / 障害対応 / ロールバック |
| [administrator/RELEASE_ROADMAP.md](./administrator/RELEASE_ROADMAP.md) | 2026/05 プレリリース → 2026/06 正式リリースに向けた 3 段階計画 (リポジトリ整理 / 環境対応 / 運用保守) |

---

## ルート直下の関連文書

docs/ 配下に含めていないが、開発・運用に関わる重要ファイル:

| ファイル | 内容 |
|---|---|
| [../README.md](../README.md) | プロジェクト概要 (外部ユーザ向け) |
| [../CLAUDE.md](../CLAUDE.md) | Claude Code 運用ガイド (AI 支援時の規約) |
| [../CONTRIBUTING.md](../CONTRIBUTING.md) | コミット / PR 規約、ブランチ運用 |
| [../SECURITY.md](../SECURITY.md) | 脆弱性報告窓口 (public-facing) |
| [../e2e/README.md](../e2e/README.md) | E2E テストの実行方法と各 spec の内容説明 |

---

## 新しいドキュメントを追加するとき

1. **読者を決める** (初見開発者 / 開発者 / 運用管理者 のどれか) → 配置ディレクトリが決まる
2. **内容の性質を確認** (仕様 / 設計 / 手順 / 知見 / 計画) → 既存ファイルとの重複を確認
3. **本索引 (docs/README.md) に 1 行追記** してエントリポイントから辿れるようにする
4. **相互参照** (他 md との関係) を冒頭に明記すると読者が迷わない
