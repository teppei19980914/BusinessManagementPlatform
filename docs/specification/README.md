# specification/ — 機能仕様書

本ディレクトリは、本サービスの **画面別機能仕様** と **画面横断的な UI 制御ルール** を集約する。ビジネスルール (状態遷移・ロール) は [../business/](../business/)、技術的実装は [../design/](../design/) を参照。

## ファイル一覧

| ファイル | 内容 | 元の所在 |
|---|---|---|
| [SCREENS.md](./SCREENS.md) | 主要 12 画面の機能仕様 + PR 別追記 (列幅リサイズ・WBS 集計・進捗整合性等) | SPECIFICATION.md §11 + §16-§24 |
| [PERMISSION_MATRIX.md](./PERMISSION_MATRIX.md) | 画面 × 操作のロール別権限マトリクス | SPECIFICATION.md §7 |
| [UI_RULES.md](./UI_RULES.md) | 共通 UI 制御ルール (画面横断のフォーム検証・確認 dialog 等) | SPECIFICATION.md §12 |
