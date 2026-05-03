# knowledge/ — ナレッジ・教訓集 (KDD)

本ディレクトリは、PR ごとに蓄積された **既存機能の改修パターン・過去の罠・解決事例** (Knowledge-Driven Development) を集約する。本サービスは KDD フローを採用しており、新規 PR で得た知見は必ず本ディレクトリに追記される。

## ファイル一覧

| ファイル | 内容 |
|---|---|
| [KDD_PATTERNS.md](./KDD_PATTERNS.md) | KDD エントリの全体集 (約 60 サブセクション、§5.1〜§5.62)。元 DEVELOPER_GUIDE.md §5 全体を時系列で保存 |
| [KNW-001_design-doc-quality-and-dev-speed.md](./KNW-001_design-doc-quality-and-dev-speed.md) | 設計ドキュメント品質と開発速度の関係 |
| [KNW-002_performance-optimization-patterns.md](./KNW-002_performance-optimization-patterns.md) | パフォーマンス最適化パターン |

## 索引: 主要なテーマ別 KDD エントリ

### 認証・認可・セキュリティ系
- §5.2 認可ルールを変える / §5.14 readOnly edit dialog の認可漏洩 / §5.19 横断ビューの可視性レイヤ整理
- §5.46 外部スクリプト導入と skill 統合 / §5.47-§5.48 セキュリティスコア初回ブリングアップ + CI Gate
- §5.51 公開範囲 (visibility) と認可マトリクスの統合 / §5.59〜§5.61 通知 deep link + コメント認可分離

### UI コンポーネント・パターン系
- §5.4-§5.7 UI レイアウト・ダイアログサイズ・state 初期化 / §5.16-§5.17 全画面トグル + Markdown
- §5.22 共通 Toolbar 化 + 3 entity 展開 / §5.24 TabsList のレスポンシブ集約
- §5.26 共通部品を必ず流用する規約 / §5.41 「○○一覧」共通 UI 部品の抽出 / §5.53 sticky thead 横展開

### データモデル・マイグレーション系
- §5.12 DB nullable 列の Zod schema / §5.28 Prisma migration UPDATE 文の罠
- §5.30 master-data.ts enum 値変更横展開 / §5.42 migration を含む PR は本番手動適用必須

### 検索・提案エンジン系
- §5.13 Issue/Retrospective 提案ロジックの統一 / §5.20 提案リスト DB 除外
- §5.38 空白区切り OR キーワード検索ヘルパ / §5.62 提案エンジン v2 の設計議論と意思決定ログ

### コミュニケーション機能系 (コメント・通知・メンション)
- §5.49 ポリモーフィックコメント機能の確立 / §5.54 アプリ内通知機能 MVP
- §5.56 コメントの @mention 機能 / §5.59〜§5.61 通知 deep link 完成 + コメント認可分離

### KDD 自体のメタ運用
- §5.50 Stop hook の重処理 / prompt 型を skill 化 / §5.55 sticky thead と readOnly hotfix
- §5.27 機能 deferral パターン / §5.32 段階的汎用化パターン

詳細はすべて [KDD_PATTERNS.md](./KDD_PATTERNS.md) で参照可能。
