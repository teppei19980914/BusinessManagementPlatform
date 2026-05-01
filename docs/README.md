# たすきば Knowledge Relay ドキュメント索引

本リポジトリのドキュメントは **役割別に分割** されており、各ディレクトリは単一責務を持つ。目当ての情報を以下の索引から辿る。

## ドキュメント構造

| ディレクトリ | 役割 | 主な内容 |
|---|---|---|
| [business/](./business/) | ビジネスロジック文書 | プロジェクトライフサイクル、テナント・プラン・課金モデル、ロール定義、MVP スコープ |
| [specification/](./specification/) | 機能仕様書 | 画面別の操作仕様、画面別権限マトリクス |
| [design/](./design/) | プログラム設計書 | アーキテクチャ、データモデル、API 設計、UI パターン、機能別詳細設計、セキュリティ設計、インフラ設計 |
| [operations/](./operations/) | 運用・移行手順書 | デプロイ手順、DB マイグレーション、AWS/Azure 移行計画、障害対応、Cron 構成、環境変数 |
| [test/](./test/) | テスト設計書 | テスト戦略、E2E カバレッジ、視覚回帰チェックリスト、E2E 教訓集 |
| [developer-guide/](./developer-guide/) | 開発者手順書 | 初期セットアップ、機能追加手順 (テーマ・マスタデータ・画面)、コミット&デプロイワークフロー |
| [knowledge/](./knowledge/) | ナレッジ・教訓集 | KDD (Knowledge-Driven Development) エントリ、過去の失敗事例と解決パターン |
| [roadmap/](./roadmap/) | ロードマップ・計画書 | リリース計画、提案エンジン v2 計画、過去の MVP 計画記録 |
| [security/](./security/) | セキュリティ設計・運用 | 脅威モデル、セキュリティタスク、セキュリティ運用手順 |
| [vision/](./vision/) | 思想・価値観 (抽象論) | 開発者本人の動機・目指す世界観・大切にする価値観・長期展望。意思決定のコンパス |
| [beginner/](./beginner/) | 初心者向けガイド | 新規参入開発者向けセットアップガイド |
| [archive/](./archive/) | アーカイブ (旧構造) | 2026-05-02 以前の単一巨大ドキュメント群 (DEVELOPER_GUIDE / DESIGN / SPECIFICATION / REQUIREMENTS など)。新規追記はせず、参考用に保全 |

## 主要ドキュメントへの直リンク

- ビジネスの中核: [business/PROJECT_LIFECYCLE.md](./business/PROJECT_LIFECYCLE.md) / [business/TENANT_AND_BILLING.md](./business/TENANT_AND_BILLING.md)
- リリース計画: [roadmap/RELEASE_ROADMAP.md](./roadmap/RELEASE_ROADMAP.md)
- 提案エンジン v2 (核心機能): [design/SUGGESTION_ENGINE.md](./design/SUGGESTION_ENGINE.md) / [roadmap/SUGGESTION_ENGINE_PLAN.md](./roadmap/SUGGESTION_ENGINE_PLAN.md) / [security/SUGGESTION_ENGINE_THREAT_MODEL.md](./security/SUGGESTION_ENGINE_THREAT_MODEL.md)
- アーキテクチャ概観: [design/ARCHITECTURE.md](./design/ARCHITECTURE.md) / [design/DATA_MODEL.md](./design/DATA_MODEL.md)
- 運用: [operations/DEPLOYMENT.md](./operations/DEPLOYMENT.md) / [operations/DB_MIGRATION_PROCEDURE.md](./operations/DB_MIGRATION_PROCEDURE.md)
- テスト: [test/STRATEGY.md](./test/STRATEGY.md) / [test/E2E_LESSONS.md](./test/E2E_LESSONS.md)
- 開発者向け: [developer-guide/HOW_TO_ADD_FEATURES.md](./developer-guide/HOW_TO_ADD_FEATURES.md)
- ナレッジ: [knowledge/README.md](./knowledge/README.md) (索引)
- 思想・価値観 (なぜ作るのか): [vision/README.md](./vision/README.md)

## ドキュメント分割の経緯

2026-05-02 までは単一の巨大ドキュメント (DEVELOPER_GUIDE.md 6600 行 / DESIGN.md 4800 行 など) に内容を累積していた。これは KDD フローによって PR ごとに知見が積み上がる結果であり、検索性と単一責務性が大きく低下していた。本構造刷新により、役割別の小さなドキュメントに分散させ、保守性と発見性を改善した。

旧ドキュメントは [archive/](./archive/) に保全されており、過去のコミット・PR からのリンクは引き続き有効。新規追記は本ディレクトリ構造に従って行う。
