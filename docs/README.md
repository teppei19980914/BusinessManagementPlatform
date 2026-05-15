# たすきば Knowledge Relay ドキュメント索引

本リポジトリのドキュメントは **役割別に分割** されている。目当ての情報は以下のリーディングパスから辿る (新規参入時) か、後半の「ドキュメント構造」「主要ドキュメント直リンク」から探す (個別調査時)。

---

## リーディングパス (新規参入時の読む順)

「このコードベースを初めて触る開発者」「数ヶ月離れて戻ってきた開発者」が、各段階で **判断できるレベル** に到達するまでの推奨順序。各段階を飛ばさず、上から読むことで前提知識の欠落を防ぐ。

### 初日 (Day 1) — 「動かせる / 何のためのプロダクトか語れる」

| # | トピック | 参照先 |
|---|---|---|
| 1 | このプロダクトは何で、なぜ存在するか | [../README.md](../README.md) → [vision/README.md](./vision/README.md) |
| 2 | MVP の範囲・対象外 | [business/MVP_SCOPE.md](./business/MVP_SCOPE.md) |
| 3 | ローカル環境を立ち上げる | [operations/SETUP_LOCAL.md](./operations/SETUP_LOCAL.md) |
| 4 | 初めての変更〜PR 作成までを体験 | [beginner/README.md](./beginner/README.md) |
| 5 | コミット / PR の規約 | [../CONTRIBUTING.md](../CONTRIBUTING.md) |

### 1週目 (Week 1) — 「コード構造を把握し、簡単な機能追加ができる」

| # | トピック | 参照先 |
|---|---|---|
| 1 | アーキテクチャ全体像 (フロント / API / DB / 外部 SaaS) | [design/ARCHITECTURE.md](./design/ARCHITECTURE.md) |
| 2 | データモデル (主要エンティティと関連) | [design/DATA_MODEL.md](./design/DATA_MODEL.md) |
| 3 | プロジェクトの状態遷移 (業務ロジックの中核) | [business/PROJECT_LIFECYCLE.md](./business/PROJECT_LIFECYCLE.md) |
| 4 | ユーザロール定義 | [business/USER_ROLES.md](./business/USER_ROLES.md) |
| 5 | テナント・プラン・課金モデル | [business/TENANT_AND_BILLING.md](./business/TENANT_AND_BILLING.md) |
| 5b | 業務用語辞書 (顧客 FB 読解時の足場) | [business/GLOSSARY.md](./business/GLOSSARY.md) |
| 5c | 機能カタログ (機能 × 顧客課題 × ファイル) | [business/FEATURE_CATALOG.md](./business/FEATURE_CATALOG.md) |
| 6 | 画面別権限マトリクス | [specification/PERMISSION_MATRIX.md](./specification/PERMISSION_MATRIX.md) |
| 7 | 主要画面の操作仕様 (該当画面のみ抜粋) | [specification/SCREENS.md](./specification/SCREENS.md) |
| 8 | API 設計 / セキュリティ設計 | [design/API_DESIGN.md](./design/API_DESIGN.md) / [design/SECURITY.md](./design/SECURITY.md) |
| 9 | 機能追加の手順 (テーマ / マスタデータ / 画面追加) | [developer-guide/HOW_TO_ADD_FEATURES.md](./developer-guide/HOW_TO_ADD_FEATURES.md) |
| 10 | テスト / lint / build 実行 | [developer-guide/TEST_LINT_BUILD.md](./developer-guide/TEST_LINT_BUILD.md) |
| 11 | コミット / デプロイのワークフロー | [developer-guide/COMMIT_AND_DEPLOY.md](./developer-guide/COMMIT_AND_DEPLOY.md) |
| 12 | テスト戦略 (単体 / 統合 / E2E / 手動) | [test/STRATEGY.md](./test/STRATEGY.md) |

### 1ヶ月目 (Month 1) — 「設計判断の背景を理解し、複雑な変更を提案できる」

| # | トピック | 参照先 |
|---|---|---|
| 1 | **主要設計判断の根拠** (なぜこの設計にしたか) | [adr/](./adr/README.md) (ADR-0001〜0013、順次追加) |
| 2 | 核心機能 — 提案エンジンの仕組み | [design/SUGGESTION_ENGINE.md](./design/SUGGESTION_ENGINE.md) |
| 3 | UI 共通パターン (テーブル / ダイアログ / 一覧フィルタ等) | [design/UI_PATTERNS.md](./design/UI_PATTERNS.md) |
| 4 | インフラ構成 (Vercel / Supabase / Brevo / Voyage 等) | [design/INFRASTRUCTURE.md](./design/INFRASTRUCTURE.md) |
| 5 | 脅威モデル (セキュリティ設計の背景) | [security/README.md](./security/) / [security/SUGGESTION_ENGINE_THREAT_MODEL.md](./security/SUGGESTION_ENGINE_THREAT_MODEL.md) |
| 6 | 障害対応の初動手順 | [operations/INCIDENT_RESPONSE.md](./operations/INCIDENT_RESPONSE.md) |
| 7 | DB マイグレーション手順 | [operations/DB_MIGRATION_PROCEDURE.md](./operations/DB_MIGRATION_PROCEDURE.md) |
| 8 | 過去の罠と教訓 (E2E の落とし穴・横展開漏れ事例) | [test/E2E_LESSONS.md](./test/E2E_LESSONS.md) / [knowledge/README.md](./knowledge/) |
| 9 | 今後のロードマップ | [roadmap/RELEASE_ROADMAP.md](./roadmap/RELEASE_ROADMAP.md) |

---

## ドキュメント構造 (個別調査用)

| ディレクトリ | 役割 | 主な内容 |
|---|---|---|
| [business/](./business/) | ビジネスロジック文書 | プロジェクトライフサイクル、テナント・プラン・課金モデル、ロール定義、MVP スコープ |
| [specification/](./specification/) | 機能仕様書 | 画面別の操作仕様、画面別権限マトリクス |
| [design/](./design/) | プログラム設計書 | アーキテクチャ、データモデル、API 設計、UI パターン、機能別詳細設計、セキュリティ設計、インフラ設計 |
| [operations/](./operations/) | 運用・移行手順書 | デプロイ手順、DB マイグレーション、AWS/Azure 移行計画、障害対応、Cron 構成、環境変数 |
| [test/](./test/) | テスト設計書 | テスト戦略、E2E カバレッジ、視覚回帰チェックリスト、E2E 教訓集 |
| [developer-guide/](./developer-guide/) | 開発者手順書 | 初期セットアップ、機能追加手順 (テーマ・マスタデータ・画面)、コミット&デプロイワークフロー |
| [adr/](./adr/) | Architecture Decision Record | 主要設計判断 (採用したライブラリ / 課金方式 / 認可方式等) の理由を時系列でログ化 |
| [knowledge/](./knowledge/) | ナレッジ・教訓集 | 過去の失敗事例と解決パターン (KDD エントリ蓄積) |
| [roadmap/](./roadmap/) | ロードマップ・計画書 | リリース計画、提案エンジン v2 計画、過去の MVP 計画記録 |
| [security/](./security/) | セキュリティ設計・運用 | 脅威モデル、セキュリティタスク、セキュリティ運用手順 |
| [vision/](./vision/) | 思想・価値観 (抽象論) | 開発者本人の動機・目指す世界観・大切にする価値観・長期展望。意思決定のコンパス |
| [beginner/](./beginner/) | 初心者向けガイド | 新規参入開発者向けセットアップ〜PR 作成までの一貫手順 |
| [public/](./public/) | 外部ユーザ向け公開ドキュメント | 利用者（非エンジニア）向けの手順書。アカウント追加手順など。リリース時に外部公開する |

---

## 主要ドキュメントへの直リンク

- ビジネスの中核: [business/PROJECT_LIFECYCLE.md](./business/PROJECT_LIFECYCLE.md) / [business/TENANT_AND_BILLING.md](./business/TENANT_AND_BILLING.md)
- リリース計画: [roadmap/RELEASE_ROADMAP.md](./roadmap/RELEASE_ROADMAP.md)
- 提案エンジン v2 (核心機能): [design/SUGGESTION_ENGINE.md](./design/SUGGESTION_ENGINE.md) / [roadmap/SUGGESTION_ENGINE_PLAN.md](./roadmap/SUGGESTION_ENGINE_PLAN.md) / [security/SUGGESTION_ENGINE_THREAT_MODEL.md](./security/SUGGESTION_ENGINE_THREAT_MODEL.md)
- アーキテクチャ概観: [design/ARCHITECTURE.md](./design/ARCHITECTURE.md) / [design/DATA_MODEL.md](./design/DATA_MODEL.md)
- 運用: [operations/DEPLOYMENT.md](./operations/DEPLOYMENT.md) / [operations/DB_MIGRATION_PROCEDURE.md](./operations/DB_MIGRATION_PROCEDURE.md)
- テスト: [test/STRATEGY.md](./test/STRATEGY.md) / [test/E2E_LESSONS.md](./test/E2E_LESSONS.md)
- 開発者向け: [developer-guide/HOW_TO_ADD_FEATURES.md](./developer-guide/HOW_TO_ADD_FEATURES.md)
- ナレッジ: [knowledge/README.md](./knowledge/README.md) (索引)
- 設計判断の根拠 (ADR): [adr/README.md](./adr/README.md)
- 思想・価値観 (なぜ作るのか): [vision/README.md](./vision/README.md)

---

## ドキュメント分割の経緯

2026-05-02 までは単一の巨大ドキュメント (DEVELOPER_GUIDE.md 6600 行 / DESIGN.md 4800 行 など) に内容を累積していた。PR ごとに知見を追記し続けた結果、検索性と単一責務性が大きく低下していたため、役割別の小さなドキュメントに分散させ、保守性と発見性を改善した。

新規追記は本ディレクトリ構造に従う。「どこに書けばいいか分からない」場合は [knowledge/](./knowledge/) に一旦書き、後で適切なディレクトリへ移す。
