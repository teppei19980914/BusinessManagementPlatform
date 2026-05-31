# test/ — テスト設計書

本ディレクトリは、本サービスのテスト戦略・カバレッジ追跡・E2E 教訓集を集約する。

## ファイル一覧

| ファイル | 内容 | 元の所在 |
|---|---|---|
| [STRATEGY.md](./STRATEGY.md) | テスト戦略全体 (自動 + 手動・テストピラミッド) | TESTING_STRATEGY.md |
| [E2E_COVERAGE.md](./E2E_COVERAGE.md) | E2E テストの画面別カバレッジ追跡 | 既存 |
| [VISUAL_REGRESSION_CHECKLIST.md](./VISUAL_REGRESSION_CHECKLIST.md) | 視覚回帰テストのチェックリスト | 既存 |
| [E2E_LESSONS.md](./E2E_LESSONS.md) | E2E テスト実装で発見した罠と解決パターン (約 50 件) | E2E_LESSONS_LEARNED.md |
| [STRIPE_PAYMENT_TEST_PROCEDURE.md](./STRIPE_PAYMENT_TEST_PROCEDURE.md) | クレジットカード払い動作確認手順 (TC-1〜TC-10、Webhook 系と共通フローの分岐) | 新規 (2026-05-21) |
| [RELEASE_ACCEPTANCE_TEST.md](./RELEASE_ACCEPTANCE_TEST.md) | リリース判定 受け入れテスト (払い出し→全資産CRUD→主要機能→解約の単一テナントライフサイクル、TC-RA-01〜) | 新規 (2026-05-31) |
