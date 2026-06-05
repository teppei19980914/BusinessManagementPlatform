# design/ — プログラム設計書

本ディレクトリは、本サービスの **技術設計** (アーキテクチャ・データモデル・API・セキュリティ・インフラ・UI パターン・機能別詳細設計) を集約する。運用手順は [../operations/](../operations/)、テスト戦略は [../test/](../test/)、ビジネスロジックは [../business/](../business/) を参照。

## ファイル一覧

| ファイル | 内容 | 元の所在 |
|---|---|---|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | 文書概要・技術スタック・アーキテクチャ全体像 | DESIGN.md §1-§3 |
| [DATA_MODEL.md](./DATA_MODEL.md) | Prisma データモデル・テーブル定義書・初期データ・インデックス戦略 | DESIGN.md §4-§5, §13, §15 |
| [API_DESIGN.md](./API_DESIGN.md) | API 設計・全文検索設計・パフォーマンス要件 | DESIGN.md §7, §16, §17 |
| [SECURITY.md](./SECURITY.md) | 権限制御設計・セキュリティ多層防御 | DESIGN.md §8-§9 + SPECIFICATION.md §25 |
| [INFRASTRUCTURE.md](./INFRASTRUCTURE.md) | Netlify + Supabase 構成・通知メール送信設計 (ADR-0023 で Vercel から移行済) | DESIGN.md §10, §18 |
| [UI_PATTERNS.md](./UI_PATTERNS.md) | UI 共通コンポーネント・ダイアログパターン・テーマ・添付・WBS インポート等の UI 設計 | DESIGN.md §11, §21-§33 |
| [USER_MANAGEMENT.md](./USER_MANAGEMENT.md) | ユーザ管理画面 (`/admin/users`) の機能別詳細設計。アカウント状態 (招待中/有効/無効)・ライフサイクル・席数(案A)・API・編集ダイアログ・監査 | 新規 (2026-06-03) |
| [TENANT_SETTINGS.md](./TENANT_SETTINGS.md) | テナント設定画面 (`/settings/tenant`) の機能別詳細設計。3 タブ (概要/使用量/請求) の全セクション・アクセス・データ入出力の区別・解約・課金関連は専用 doc へ参照 | 新規 (2026-06-03) |
| [SUGGESTION_ENGINE.md](./SUGGESTION_ENGINE.md) | 核心機能 (提案エンジン v1 + v2) の技術設計全体 | DESIGN.md §23, §34 |
| [STRIPE_TECHNICAL_DESIGN.md](./STRIPE_TECHNICAL_DESIGN.md) | Stripe Metered Billing 連携の詳細技術設計 (= 「how」レベル、各 PR の実装時に参照する判断保留不要の粒度) | 新規 (2026-05-14) |
| [MASCOT.md](./MASCOT.md) | 公式マスコット「たすきフクロウ」の選定根拠・象徴・デザイン規範・使い方 | 新規 (2026-05-27) |
| [CRON_JOBS.md](./CRON_JOBS.md) | 外部 cron (cron-job.org) のジョブ一覧・スケジュール・閾値・死活監視 (真実源 = `src/config/cron-jobs.ts`) | 新規 |
| [ENVIRONMENT_VARIABLES.md](./ENVIRONMENT_VARIABLES.md) | 全環境変数の一覧・説明・Netlify context 別の設定状況 (as-built) | 新規 |
| [STRIPE_ENV_MAPPING.md](./STRIPE_ENV_MAPPING.md) | Stripe Price / Meter ID と環境変数のマッピング (as-built 対応表) | 新規 |
| [STRIPE_EMBEDDING_PRICE_SETTINGS.md](./STRIPE_EMBEDDING_PRICE_SETTINGS.md) | Embedding 単価 (¥1→¥5, ADR-0029) の Stripe Price 設定記録 | 新規 |
| [SERVICES.md](./SERVICES.md) | service 層カタログ (実装ミラー)。`src/services/**` 78 ファイルを責務別に一覧化し、各 service の主要 export・課金有無・テナント分離引数を表化 | 新規 |
| [KEY_FLOWS.md](./KEY_FLOWS.md) | **連結フロー資料**。標準リクエストライフサイクル (画面→route→service→DB→toast) + 課金 money-flow / 非同期 embedding / オンボーディング / cascade delete 等の代表フロー (mermaid 図) | 新規 |
| [CONFIGURATION.md](./CONFIGURATION.md) | `src/config/**` 全チューナブル定数の単一リファレンス (価格/上限/レート制限/閾値 + source file:line + 変更時の影響) | 新規 |
| [STATE_REFERENCE.md](./STATE_REFERENCE.md) | 状態/ステータスフィールド横断リファレンス (project status / embedding_status / stripe / Beginner expiry / circuit breaker 等の値・遷移、mermaid 状態図) | 新規 |
| [OBSERVABILITY.md](./OBSERVABILITY.md) | 監視・記録・アラート設計 (監査/エラー/cron 実行ログ、cron 死活監視・課金 drift 検知・診断・アラート cron) | 新規 |


## archive 移動済 (履歴参照)

| 旧パス | 現在の場所 | 移動日 |
|---|---|---|
| docs/design/RESPONSIVE_AUDIT.md | [../archive/audits/RESPONSIVE_AUDIT.md](../archive/audits/RESPONSIVE_AUDIT.md) | 2026-05-17 |
| docs/design/performance/20260417/ | [../archive/performance/20260417/](../archive/performance/20260417/) | 2026-05-17 |

## 提案エンジン v2 の関連ドキュメント

提案エンジン v2 (T-03 / 2026-06-01 リリース) は本サービスの核心機能であり、複数のドキュメントにまたがる。

- ビジネスロジック: [../business/TENANT_AND_BILLING.md](../business/TENANT_AND_BILLING.md)
- 技術設計: [SUGGESTION_ENGINE.md](./SUGGESTION_ENGINE.md)
- 脅威モデル: [../security/SUGGESTION_ENGINE_THREAT_MODEL.md](../security/SUGGESTION_ENGINE_THREAT_MODEL.md)
- 実装計画 (実装完了済・archive): [../archive/roadmap/SUGGESTION_ENGINE_PLAN.md](../archive/roadmap/SUGGESTION_ENGINE_PLAN.md)
