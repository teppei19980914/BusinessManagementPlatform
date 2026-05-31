# specification/ — 機能仕様書

本ディレクトリは、本サービスの **画面別機能仕様** と **画面横断的な UI 制御ルール** を集約する。ビジネスルール (状態遷移・ロール) は [../business/](../business/)、技術的実装は [../design/](../design/) を参照。

## ファイル一覧

| ファイル | 内容 | 元の所在 |
|---|---|---|
| [SCREENS.md](./SCREENS.md) | **全画面網羅 (実装ミラー)**。dashboard 40 + auth 5 の全画面の目的 / 操作 / 主要 UI / 権限 / 関連 route・service。§0 に全画面インベントリ、§11 以降に主要画面の詳細仕様 | SPECIFICATION.md §11 + §16-§24 |
| [PERMISSION_MATRIX.md](./PERMISSION_MATRIX.md) | 画面 × 操作のロール別権限マトリクス + §0 に `check-permission.ts` ROLE_PERMISSIONS の Action×ロール完全ミラー | SPECIFICATION.md §7 |
| [UI_RULES.md](./UI_RULES.md) | 共通 UI 制御ルール (確認ダイアログ / 未保存変更ガード / フォーム検証・送信制御 等) | SPECIFICATION.md §12 |
| [SUGGESTION_FEATURE.md](./SUGGESTION_FEATURE.md) | **核心機能 (提案機能) の機能仕様 + コスト構造**。スコア閾値 0.01 / 上限 50・相対分位 tier / Pro 限定「なぜ?」説明文 / 月次コスト試算 / 監視ポイント | 新規 (2026-05-03) |
| [STRIPE_PAYMENT_UI.md](./STRIPE_PAYMENT_UI.md) | クレジットカード払い UI 仕様。`/settings/tenant` 支払い方法セクション、Stripe Checkout 連携 (Customer Portal は撤去済)、プラン変更時のカード検証 UI、「今月請求金額」セクション (ADR-0030) | 新規 (2026-05-14) |
| [CHAT_SEMANTIC_SEARCH.md](./CHAT_SEMANTIC_SEARCH.md) | **チャットボット意味検索機能の仕様 + 脅威モデル別対策**。5 資産横断意味検索 (Project / Knowledge / RiskIssue / Retrospective / Memo)、Embedding 従量課金 (Beginner ¥0 / Expert・Pro ¥5)、pgvector index 無し=全走査 + pg_trgm fallback、tier 段階表示、縮退モード | 新規 (2026-05-23 / v1 実装決定で roadmap/future から復帰) |
| [HELP_CHAT.md](./HELP_CHAT.md) | たすきフクロウ AI ヘルプチャット (ADR-0027/0028 RAG) の仕様。search/help タブ統合、FaqEmbedding/GuideEmbedding、月 100 件上限・全プラン無料 (LEARNING_FREE) | 新規 |
| [BEGINNER_PLAN.md](./BEGINNER_PLAN.md) | Beginner プランの UI/挙動仕様。試用期間と expired 遷移 (60/75/90 日)、DB/Storage 無料枠超過時 write block (ADR-0025)、Embedding 月 100 件試用上限 (ADR-0030)、storage-guard 4 層防御 | 新規 |
