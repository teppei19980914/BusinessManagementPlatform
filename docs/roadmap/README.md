# roadmap/ — ロードマップ・計画書

本ディレクトリは、リリース計画と将来構想を集約する。

## ファイル一覧

| ファイル | 内容 | 状態 |
|---|---|---|
| [RELEASE_ROADMAP.md](./RELEASE_ROADMAP.md) | リリースロードマップ全体 (Phase 1〜Phase 3) | active(Phase 3 運用保守が継続) |
| [STRIPE_INTEGRATION_PLAN.md](./STRIPE_INTEGRATION_PLAN.md) | Stripe Metered Billing 連携の実装ロードマップ (v1.x) | active(Stripe v1.x リリース後 archive 予定) |
| [future/](./future/) | v2 以降の将来構想 (active な仕様と完了済履歴の中間配置) | active |

## archive 移動済 (履歴参照)

| 旧パス | 現在の場所 | 移動日・経緯 |
|---|---|---|
| docs/roadmap/MVP_HISTORICAL.md | [../archive/roadmap/MVP_HISTORICAL.md](../archive/roadmap/MVP_HISTORICAL.md) | 2026-05-17 |
| docs/roadmap/V1_FINAL_TASKS.md | [../archive/roadmap/V1_FINAL_TASKS.md](../archive/roadmap/V1_FINAL_TASKS.md) | 2026-05-19(実装完了済のため前倒し archive) |
| docs/roadmap/SUGGESTION_ENGINE_PLAN.md | [../archive/roadmap/SUGGESTION_ENGINE_PLAN.md](../archive/roadmap/SUGGESTION_ENGINE_PLAN.md) | 2026-05-19(T-03 提案エンジン v2 実装完了済) |
| docs/roadmap/ROLE_REFACTORING_PLAN.md | [../archive/roadmap/ROLE_REFACTORING_PLAN.md](../archive/roadmap/ROLE_REFACTORING_PLAN.md) | 2026-05-19(ロール体系実装完了済) |

## 提案エンジン v2 の関連ドキュメント

提案エンジン v2 (T-03) は本サービスの核心機能であり、複数のドキュメントにまたがる。実装計画は archive 化済のため、参照は以下:

- ビジネスロジック: [../business/TENANT_AND_BILLING.md](../business/TENANT_AND_BILLING.md)
- 技術設計: [../design/SUGGESTION_ENGINE.md](../design/SUGGESTION_ENGINE.md)
- 脅威モデル: [../security/SUGGESTION_ENGINE_THREAT_MODEL.md](../security/SUGGESTION_ENGINE_THREAT_MODEL.md)
- 設計判断: [../adr/0003-embedding-based-suggestion-engine.md](../adr/0003-embedding-based-suggestion-engine.md) / [../adr/0008-graceful-degradation-mode.md](../adr/0008-graceful-degradation-mode.md)
- 実装計画(履歴): [../archive/roadmap/SUGGESTION_ENGINE_PLAN.md](../archive/roadmap/SUGGESTION_ENGINE_PLAN.md)
- リリースノート: [../operations/T-03_RELEASE_NOTES.md](../operations/T-03_RELEASE_NOTES.md)
- 改修検証記録: [../operations/SUGGESTION_ENGINE_VERIFICATION.md](../operations/SUGGESTION_ENGINE_VERIFICATION.md)

## 6/1 リリース前残作業

6/1 リリース前の残作業は公開準備(法的書類・公開ページ)に絞られています。詳細は:

- [../operations/PUBLIC_LAUNCH_CHECKLIST.md](../operations/PUBLIC_LAUNCH_CHECKLIST.md) — 公開前チェックリスト
- [../operations/GO_LIVE_RUNBOOK.md](../operations/GO_LIVE_RUNBOOK.md) — 公開当日の時系列手順
