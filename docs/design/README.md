# design/ — プログラム設計書

本ディレクトリは、本サービスの **技術設計** (アーキテクチャ・データモデル・API・セキュリティ・インフラ・UI パターン・機能別詳細設計) を集約する。運用手順は [../operations/](../operations/)、テスト戦略は [../test/](../test/)、ビジネスロジックは [../business/](../business/) を参照。

## ファイル一覧

| ファイル | 内容 | 元の所在 |
|---|---|---|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | 文書概要・技術スタック・アーキテクチャ全体像 | DESIGN.md §1-§3 |
| [DATA_MODEL.md](./DATA_MODEL.md) | Prisma データモデル・テーブル定義書・初期データ・インデックス戦略 | DESIGN.md §4-§5, §13, §15 |
| [API_DESIGN.md](./API_DESIGN.md) | API 設計・全文検索設計・パフォーマンス要件 | DESIGN.md §7, §16, §17 |
| [SECURITY.md](./SECURITY.md) | 権限制御設計・セキュリティ多層防御 | DESIGN.md §8-§9 + SPECIFICATION.md §25 |
| [INFRASTRUCTURE.md](./INFRASTRUCTURE.md) | Vercel + Supabase 構成・通知メール送信設計 | DESIGN.md §10, §18 |
| [UI_PATTERNS.md](./UI_PATTERNS.md) | UI 共通コンポーネント・ダイアログパターン・テーマ・添付・WBS インポート等の UI 設計 | DESIGN.md §11, §21-§33 |
| [SUGGESTION_ENGINE.md](./SUGGESTION_ENGINE.md) | 核心機能 (提案エンジン v1 + v2) の技術設計全体 | DESIGN.md §23, §34 |
| [RESPONSIVE_AUDIT.md](./RESPONSIVE_AUDIT.md) | レスポンシブ実装の網羅的監査 | 既存 |
| [performance/](./performance/) | パフォーマンス調査・改善履歴 | 既存 |

## 提案エンジン v2 の関連ドキュメント

提案エンジン v2 (T-03 / 2026-06-01 リリース) は本サービスの核心機能であり、複数のドキュメントにまたがる。

- ビジネスロジック: [../business/TENANT_AND_BILLING.md](../business/TENANT_AND_BILLING.md)
- 技術設計: [SUGGESTION_ENGINE.md](./SUGGESTION_ENGINE.md)
- 脅威モデル: [../security/SUGGESTION_ENGINE_THREAT_MODEL.md](../security/SUGGESTION_ENGINE_THREAT_MODEL.md)
- 実装計画: [../roadmap/SUGGESTION_ENGINE_PLAN.md](../roadmap/SUGGESTION_ENGINE_PLAN.md)
