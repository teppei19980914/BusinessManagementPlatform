# roadmap/ — ロードマップ・計画書

本ディレクトリは、リリース計画と機能別の実装計画を集約する。

## ファイル一覧

| ファイル | 内容 | 元の所在 |
|---|---|---|
| [RELEASE_ROADMAP.md](./RELEASE_ROADMAP.md) | リリースロードマップ全体 (Phase 1〜Phase 3) | 既存 |
| [SUGGESTION_ENGINE_PLAN.md](./SUGGESTION_ENGINE_PLAN.md) | 提案エンジン v2 の実装計画 (PR 分割・スケジュール・意思決定ログ) | 既存 |
| [ROLE_REFACTORING_PLAN.md](./ROLE_REFACTORING_PLAN.md) | ロール再構築計画 (テナント管理者 + システム管理者の二層化、6/1 リリース目標) | 新規 (2026-05-03) |
| [V1_FINAL_TASKS.md](./V1_FINAL_TASKS.md) | 6/1 リリース最終追加実装タスク (PR-X1〜X5 集約、明日以降着手) | 新規 (2026-05-03) |
| [MVP_HISTORICAL.md](./MVP_HISTORICAL.md) | MVP 構築時の計画 (2026-04-15 完了時点の履歴記録、固定化済) | PLAN.md |

## 提案エンジン v2 の関連ドキュメント

提案エンジン v2 (T-03 / 2026-06-01 リリース) は本サービスの核心機能であり、複数のドキュメントにまたがる。

- ビジネスロジック: [../business/TENANT_AND_BILLING.md](../business/TENANT_AND_BILLING.md)
- 技術設計: [../design/SUGGESTION_ENGINE.md](../design/SUGGESTION_ENGINE.md)
- 脅威モデル: [../security/SUGGESTION_ENGINE_THREAT_MODEL.md](../security/SUGGESTION_ENGINE_THREAT_MODEL.md)
- 実装計画: [SUGGESTION_ENGINE_PLAN.md](./SUGGESTION_ENGINE_PLAN.md)
