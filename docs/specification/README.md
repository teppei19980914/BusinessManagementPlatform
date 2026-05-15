# specification/ — 機能仕様書

本ディレクトリは、本サービスの **画面別機能仕様** と **画面横断的な UI 制御ルール** を集約する。ビジネスルール (状態遷移・ロール) は [../business/](../business/)、技術的実装は [../design/](../design/) を参照。

## ファイル一覧

| ファイル | 内容 | 元の所在 |
|---|---|---|
| [SCREENS.md](./SCREENS.md) | 主要 12 画面の機能仕様 + PR 別追記 (列幅リサイズ・WBS 集計・進捗整合性等) | SPECIFICATION.md §11 + §16-§24 |
| [PERMISSION_MATRIX.md](./PERMISSION_MATRIX.md) | 画面 × 操作のロール別権限マトリクス | SPECIFICATION.md §7 |
| [UI_RULES.md](./UI_RULES.md) | 共通 UI 制御ルール (画面横断のフォーム検証・確認 dialog 等) | SPECIFICATION.md §12 |
| [SUGGESTION_FEATURE.md](./SUGGESTION_FEATURE.md) | **核心機能 (提案機能) の機能仕様 + コスト構造**。API 呼び出しトリガー / プラン別挙動 / 月次コスト試算 / 監視ポイント。事業継続判断の根拠資料 | 新規 (2026-05-03) |
| [CHAT_SEMANTIC_SEARCH.md](./CHAT_SEMANTIC_SEARCH.md) | **チャットボット意味検索機能の仕様 + コスト構造**。ユーザ自発の自然文検索経路。提案機能と同じ embedding 基盤を共有し、5 資産横断で意味検索 → tier 段階表示。ハイブリッド課金 (Beginner のみ月100回枠を書込と共有、Expert/Pro 無料) | 新規 (2026-05-15) |
| [STRIPE_PAYMENT_UI.md](./STRIPE_PAYMENT_UI.md) | クレジットカード払い UI 仕様 (v1.x)。`/settings/tenant` 支払い方法セクション、Stripe Checkout 連携、Customer Portal 埋め込み、プラン変更時のカード検証 UI | 新規 (2026-05-14) |
