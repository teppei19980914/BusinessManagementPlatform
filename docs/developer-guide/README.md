# developer-guide/ — 開発者手順書

本ディレクトリは、開発者が日常的に参照する **手順書とリファレンス** を集約する。過去 PR で蓄積された改修パターンや罠は [../knowledge/](../knowledge/) を参照。

## ファイル一覧

| ファイル | 内容 | 元の所在 |
|---|---|---|
| [DEVELOPMENT_FLOW.md](./DEVELOPMENT_FLOW.md) | 開発着手 → リリースまでの全工程 (Phase 1〜8) + トラブルシューティング | PR #425 ベース新規 (2026-05-22) |
| [LOCAL_TEST_GUIDE.md](./LOCAL_TEST_GUIDE.md) | vitest 単体テストの Tips + mock パターン集 + よくある罠 | PR #425 ベース新規 (2026-05-22) |
| [E2E_TEST_GUIDE.md](./E2E_TEST_GUIDE.md) | Playwright E2E 実装 Tips + カバレッジ維持 + 視覚回帰 baseline 運用 | PR #425 ベース新規 (2026-05-22) |
| [SECURITY_CHECK_GUIDE.md](./SECURITY_CHECK_GUIDE.md) | セキュリティチェック CI の弾かれ対処 + 典型パターン (KDD §5.X+86〜88, §5.X+103 等) | PR #425 ベース新規 (2026-05-22) |
| [HOW_TO_ADD_FEATURES.md](./HOW_TO_ADD_FEATURES.md) | テーマカラー・マスタデータ・新画面・新機能の追加手順 + 機能削除手順 + i18n 追加 | DEVELOPER_GUIDE.md §1-§4, §6, §8 |
| [TEST_LINT_BUILD.md](./TEST_LINT_BUILD.md) | pnpm test / lint / build の実行方法と CI フロー | DEVELOPER_GUIDE.md §9 |
| [COMMIT_AND_DEPLOY.md](./COMMIT_AND_DEPLOY.md) | DB スキーマ変更 + コミット + PR + デプロイのワークフロー | DEVELOPER_GUIDE.md §7, §10 |
| [SEED_DATA_MAINTENANCE.md](./SEED_DATA_MAINTENANCE.md) | シードデータの維持・更新ガイド | — |
| [TODO_LIST.md](./TODO_LIST.md) | 後続 PR で対応予定のタスク一覧 | DEVELOPER_GUIDE.md §11 |
| [REFERENCE.md](./REFERENCE.md) | 設計原則のリマインダ + よくある質問 | DEVELOPER_GUIDE.md 付録 A・B |

## 読む順序の推奨

新規参入時・引き継ぎ時の推奨リーディングパス:

1. [DEVELOPMENT_FLOW.md](./DEVELOPMENT_FLOW.md) で **全工程の流れ** を把握 (Phase 1〜8)
2. [HOW_TO_ADD_FEATURES.md](./HOW_TO_ADD_FEATURES.md) で **機能追加の実装手順** を確認
3. [LOCAL_TEST_GUIDE.md](./LOCAL_TEST_GUIDE.md) + [E2E_TEST_GUIDE.md](./E2E_TEST_GUIDE.md) で **テストの書き方** を学習
4. [COMMIT_AND_DEPLOY.md](./COMMIT_AND_DEPLOY.md) でコミット〜デプロイの運用ルールを確認
5. CI で弾かれたら [SECURITY_CHECK_GUIDE.md](./SECURITY_CHECK_GUIDE.md) と [TEST_LINT_BUILD.md](./TEST_LINT_BUILD.md) で対処
