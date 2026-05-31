# たすきば Knowledge Relay ドキュメント索引

本ディレクトリは **役割別に分割された全ドキュメント** を集約します。

> **新規参入者向けクイックスタート** はリポジトリ直下の [`ONBOARDING.md`](../ONBOARDING.md) を参照(環境構築 → 動作確認 → PR 作成 → CI まで自己完結)。
>
> 本書は ONBOARDING.md 完了後に「サービスを理解する」ために `docs/` を歩く際の **完全索引** です。

---

## 全体マップ

```
docs/
├── business/         ビジネスロジック (プロジェクト状態 / 課金 / ロール / 用語辞書 / 機能カタログ)
├── specification/    機能仕様 (画面 / 権限マトリクス / UI ルール)
├── design/           技術設計 (アーキテクチャ / データモデル / API / セキュリティ / インフラ / UI / 提案エンジン)
├── operations/       運用保守 (開発作業 develop / 運用業務 operate / 再構築 setup / post-mortems)
├── test/             テスト戦略 (戦略 / E2E カバレッジ / 視覚回帰 / E2E 教訓)
├── knowledge/        ナレッジ蓄積 (KDD パターン集 — 過去の罠と教訓)
├── adr/              設計判断記録 (ADR-0001〜0030 — なぜこの設計か)
│                     (roadmap/ は 2026-06-01 に archive/2026-06-01-pre-ops-reorg/roadmap/ へ移行。未実装計画は operations/ROADMAP.md に集約)
├── security/         セキュリティ (脅威モデル / STRIDE 手順 / セキュリティタスク)
├── vision/           思想・価値観 (なぜ作るのか、長期展望)
├── public/           外部ユーザ向け公開ドキュメント (リリース時公開)
└── archive/          完了済イベントの記録 (履歴保全)
```

---

## リーディングパス (新規参入時の読む順)

「初めて触る開発者」「数ヶ月離れて戻ってきた開発者」が、各段階で **判断できるレベル** に到達するまでの推奨順序。各段階を飛ばさず、上から読むことで前提知識の欠落を防ぐ。

### 初日 (Day 1) — 「動かせる / 何のためのプロダクトか語れる」

| # | トピック | 参照先 |
|---|---|---|
| 1 | このプロダクトは何で、なぜ存在するか | [../README.md](../README.md) → [vision/README.md](./vision/README.md) |
| 2 | MVP の範囲・対象外 | [business/MVP_SCOPE.md](./business/MVP_SCOPE.md) |
| 3 | 環境構築から PR 作成・CI 確認まで | [../ONBOARDING.md](../ONBOARDING.md) |
| 4 | コミット / PR の規約 | [../CONTRIBUTING.md](../CONTRIBUTING.md) |

### 1週目 (Week 1) — 「コード構造を把握し、簡単な機能追加ができる」

| # | トピック | 参照先 |
|---|---|---|
| 1 | アーキテクチャ全体像 + 主要ディレクトリ | [design/ARCHITECTURE.md](./design/ARCHITECTURE.md) |
| 2 | データモデル (主要エンティティと関連) | [design/DATA_MODEL.md](./design/DATA_MODEL.md) |
| 3 | プロジェクトの状態遷移 (業務ロジックの中核) | [business/PROJECT_LIFECYCLE.md](./business/PROJECT_LIFECYCLE.md) |
| 4 | ユーザロール定義 | [business/USER_ROLES.md](./business/USER_ROLES.md) |
| 5 | テナント・プラン・課金モデル | [business/TENANT_AND_BILLING.md](./business/TENANT_AND_BILLING.md) |
| 5b | 業務用語辞書 (顧客 FB 読解時の足場) | [business/GLOSSARY.md](./business/GLOSSARY.md) |
| 5c | 機能カタログ (機能 × 顧客課題 × ファイル) | [business/FEATURE_CATALOG.md](./business/FEATURE_CATALOG.md) |
| 6 | 画面別権限マトリクス | [specification/PERMISSION_MATRIX.md](./specification/PERMISSION_MATRIX.md) |
| 7 | 主要画面の操作仕様 (該当画面のみ抜粋) | [specification/SCREENS.md](./specification/SCREENS.md) |
| 8 | API 設計 / セキュリティ設計 | [design/API_DESIGN.md](./design/API_DESIGN.md) / [design/SECURITY.md](./design/SECURITY.md) |
| 9 | 機能追加の手順 (テーマ / マスタデータ / 画面追加) | [operations/develop/HOW_TO_ADD_FEATURES.md](./operations/develop/HOW_TO_ADD_FEATURES.md) |
| 10 | テスト / lint / build 実行 | [operations/develop/TEST_LINT_BUILD.md](./operations/develop/TEST_LINT_BUILD.md) |
| 11 | コミット / デプロイのワークフロー | [operations/develop/COMMIT_AND_DEPLOY.md](./operations/develop/COMMIT_AND_DEPLOY.md) |
| 12 | テスト戦略 (単体 / 統合 / E2E / 手動) | [test/STRATEGY.md](./test/STRATEGY.md) |

### 1ヶ月目 (Month 1) — 「設計判断の背景を理解し、複雑な変更を提案できる」

| # | トピック | 参照先 |
|---|---|---|
| 1 | **主要設計判断の根拠** (なぜこの設計にしたか) | [adr/](./adr/README.md) (ADR-0001〜0030) |
| 2 | 核心機能 — 提案エンジンの仕組み | [design/SUGGESTION_ENGINE.md](./design/SUGGESTION_ENGINE.md) |
| 3 | UI 共通パターン (テーブル / ダイアログ / 一覧フィルタ等) | [design/UI_PATTERNS.md](./design/UI_PATTERNS.md) |
| 4 | インフラ構成 (Netlify / Supabase / Brevo / Voyage 等) | [design/INFRASTRUCTURE.md](./design/INFRASTRUCTURE.md) |
| 5 | 脅威モデル (セキュリティ設計の背景) | [security/README.md](./security/) / [security/SUGGESTION_ENGINE_THREAT_MODEL.md](./security/SUGGESTION_ENGINE_THREAT_MODEL.md) |
| 6 | 障害対応の初動手順 | [operations/operate/INCIDENT_RESPONSE.md](./operations/operate/INCIDENT_RESPONSE.md) |
| 7 | DB マイグレーション手順 | [operations/develop/DB_MIGRATION_PROCEDURE.md](./operations/develop/DB_MIGRATION_PROCEDURE.md) |
| 8 | 過去の罠と教訓 (E2E の落とし穴・横展開漏れ事例) | [test/E2E_LESSONS.md](./test/E2E_LESSONS.md) / [knowledge/README.md](./knowledge/) |
| 9 | 今後のロードマップ (運用保守・未実装計画の living 集約先) | [operations/ROADMAP.md](./operations/ROADMAP.md) |

---

## ディレクトリ別 完全索引

### [business/](./business/) — ビジネスロジック文書

業務ルール・運用フロー・課金モデルなど **ビジネスロジックの中核**。

| ファイル | 内容 |
|---|---|
| [README.md](./business/README.md) | business/ ディレクトリ索引 + Stripe/提案エンジン横断索引 |
| [PROJECT_LIFECYCLE.md](./business/PROJECT_LIFECYCLE.md) | プロジェクト状態マシン (7 状態の一方向遷移) + 操作制限・ロック条件 |
| [USER_ROLES.md](./business/USER_ROLES.md) | システムロール (super_admin / admin) + プロジェクトロール (PM / TL / member / viewer) の権限定義 |
| [TENANT_AND_BILLING.md](./business/TENANT_AND_BILLING.md) | マルチテナント運用フロー + 3 プラン構成 (Beginner/Expert/Pro) + per-API-call 従量課金 |
| [PAYMENT_TERMS.md](./business/PAYMENT_TERMS.md) | 請求書 / 銀行振込支払いの期日条件・滞納時の対外ルール |
| [STRIPE_BILLING.md](./business/STRIPE_BILLING.md) | Stripe Metered Billing 連携仕様 (v1.x で実装予定) |
| [MVP_SCOPE.md](./business/MVP_SCOPE.md) | MVP 必須機能一覧・対象外機能・管理項目一覧 |
| [GLOSSARY.md](./business/GLOSSARY.md) | 業務用語辞書 (プロジェクト/テナント/プラン/提案エンジン/ロール 等の正式名と意味) |
| [FEATURE_CATALOG.md](./business/FEATURE_CATALOG.md) | 機能カタログ (7 カテゴリ × 機能 × 顧客課題 × 主な変更先ファイル) — 顧客 FB トリアージ用 |

### [specification/](./specification/) — 機能仕様書

画面別の操作仕様と権限マトリクス。

| ファイル | 内容 |
|---|---|
| [README.md](./specification/README.md) | specification/ ディレクトリ索引 |
| [SCREENS.md](./specification/SCREENS.md) | 全画面網羅 (実装ミラー)。dashboard 40 + auth 5 の全画面仕様 (§0 インベントリ + 主要画面詳細) |
| [PERMISSION_MATRIX.md](./specification/PERMISSION_MATRIX.md) | 画面 × 操作のロール別権限マトリクス + ROLE_PERMISSIONS 完全ミラー |
| [UI_RULES.md](./specification/UI_RULES.md) | 共通 UI 制御ルール (確認ダイアログ / 未保存変更ガード / フォーム検証等) |
| [SUGGESTION_FEATURE.md](./specification/SUGGESTION_FEATURE.md) | 核心機能 (提案機能) の機能仕様 + コスト構造 |
| [STRIPE_PAYMENT_UI.md](./specification/STRIPE_PAYMENT_UI.md) | クレジットカード払い UI 仕様 + 「今月請求金額」(ADR-0030) |
| [CHAT_SEMANTIC_SEARCH.md](./specification/CHAT_SEMANTIC_SEARCH.md) | チャット意味検索の機能仕様 + 脅威モデル別対策 (Embedding 従量課金) |
| [HELP_CHAT.md](./specification/HELP_CHAT.md) | たすきフクロウ AI ヘルプチャット (ADR-0027/0028 RAG) の仕様 |
| [BEGINNER_PLAN.md](./specification/BEGINNER_PLAN.md) | Beginner プランの UI/挙動仕様 (試用期間・write block・Embedding 月100件) |

### [design/](./design/) — プログラム設計書

技術設計 (アーキテクチャ / データモデル / API / セキュリティ / インフラ / UI パターン / 機能別詳細)。

| ファイル | 内容 |
|---|---|
| [README.md](./design/README.md) | design/ ディレクトリ索引 |
| [ARCHITECTURE.md](./design/ARCHITECTURE.md) | 文書概要・技術スタック・アーキテクチャ全体像 + **主要ディレクトリ構造 §4** |
| [DATA_MODEL.md](./design/DATA_MODEL.md) | Prisma データモデル・テーブル定義・初期データ・インデックス戦略 |
| [API_DESIGN.md](./design/API_DESIGN.md) | API 設計・全文検索設計・パフォーマンス要件 |
| [SECURITY.md](./design/SECURITY.md) | 権限制御設計・セキュリティ多層防御 |
| [INFRASTRUCTURE.md](./design/INFRASTRUCTURE.md) | Netlify + Supabase 構成・通知メール送信設計 (ADR-0023) |
| [UI_PATTERNS.md](./design/UI_PATTERNS.md) | UI 共通コンポーネント・ダイアログパターン・テーマ・添付・WBS インポート等 |
| [SUGGESTION_ENGINE.md](./design/SUGGESTION_ENGINE.md) | 核心機能 (提案エンジン v1 + v2) の技術設計全体 |
| [STRIPE_TECHNICAL_DESIGN.md](./design/STRIPE_TECHNICAL_DESIGN.md) | Stripe Metered Billing 連携の詳細技術設計 |
| [MASCOT.md](./design/MASCOT.md) | 公式マスコット「たすきフクロウ」の選定根拠・象徴・デザイン規範 |
| [CRON_JOBS.md](./design/CRON_JOBS.md) | 外部 cron (cron-job.org) のジョブ一覧・スケジュール・閾値・死活監視 |
| [ENVIRONMENT_VARIABLES.md](./design/ENVIRONMENT_VARIABLES.md) | 全環境変数の一覧・Netlify context 別の設定状況 (as-built) |
| [STRIPE_ENV_MAPPING.md](./design/STRIPE_ENV_MAPPING.md) | Stripe Price / Meter ID と環境変数のマッピング |
| [STRIPE_EMBEDDING_PRICE_SETTINGS.md](./design/STRIPE_EMBEDDING_PRICE_SETTINGS.md) | Embedding 単価 (¥1→¥5, ADR-0029) の Stripe Price 設定記録 |
| [SERVICES.md](./design/SERVICES.md) | service 層カタログ (実装ミラー、78 ファイルを責務別に一覧) |
| [KEY_FLOWS.md](./design/KEY_FLOWS.md) | **連結フロー資料** (標準リクエストライフサイクル + 課金/embedding/オンボーディング等の代表フロー、mermaid) |
| [CONFIGURATION.md](./design/CONFIGURATION.md) | `src/config/**` 全チューナブル定数の単一リファレンス |
| [STATE_REFERENCE.md](./design/STATE_REFERENCE.md) | 状態/ステータスフィールド横断リファレンス (mermaid 状態図) |
| [OBSERVABILITY.md](./design/OBSERVABILITY.md) | 監視・記録・アラート設計 |

### [operations/](./operations/) — 運用保守 (シナリオ別)

旧 `developer-guide/` を吸収し、シナリオ別の 4 サブディレクトリ (develop / operate / setup / post-mortems) に再編。トップ索引は [operations/README.md](./operations/README.md) を正とする。

| ファイル | 内容 |
|---|---|
| [README.md](./operations/README.md) | operations/ 運用保守トップ索引 (develop / operate / setup / post-mortems の導線) |
| [ENV_VARS.md](./operations/ENV_VARS.md) | 全環境変数の一覧と説明 |
| [MIGRATION_TO_AWS.md](./operations/MIGRATION_TO_AWS.md) | Netlify + Supabase から AWS / Azure / GCP への将来的移行計画 |
| [DOGFOODING_PLAN.md](./operations/DOGFOODING_PLAN.md) | Dogfooding 計画 (6/15 ± 1 週、AI 補助なしで 1 機能実装) |

#### [operations/develop/](./operations/develop/) — 開発作業手順

機能追加・テスト・コミット&デプロイ・DB マイグレーション・Seed メンテなど、コードを変更する開発者の実務手順 (旧 developer-guide/ 由来 + 旧 operations 直下の開発系)。

| ファイル | 内容 |
|---|---|
| [DEVELOPMENT_FLOW.md](./operations/develop/DEVELOPMENT_FLOW.md) | 開発着手 → リリースまでの全工程手順書 (Phase 1〜8 + トラブルシューティング) |
| [HOW_TO_ADD_FEATURES.md](./operations/develop/HOW_TO_ADD_FEATURES.md) | 機能追加手順 (テーマ / マスタデータ / 画面追加 / DB 変更 / i18n 等) |
| [MODIFY_FEATURE.md](./operations/develop/MODIFY_FEATURE.md) | 既存機能の変更手順 (影響範囲特定 / 横展開 / 退行防止) |
| [TEST_LINT_BUILD.md](./operations/develop/TEST_LINT_BUILD.md) | テスト・lint・build 実行ガイド |
| [LOCAL_TEST_GUIDE.md](./operations/develop/LOCAL_TEST_GUIDE.md) | vitest 単体テスト Tips + mock パターン集 + よくある罠 |
| [E2E_TEST_GUIDE.md](./operations/develop/E2E_TEST_GUIDE.md) | Playwright E2E Tips + カバレッジ維持 + 視覚回帰 baseline 運用 |
| [SECURITY_CHECK_GUIDE.md](./operations/develop/SECURITY_CHECK_GUIDE.md) | セキュリティチェック CI の弾かれ対処 + 典型パターン |
| [COMMIT_AND_DEPLOY.md](./operations/develop/COMMIT_AND_DEPLOY.md) | コミットとデプロイ ワークフロー |
| [DEPLOYMENT.md](./operations/develop/DEPLOYMENT.md) | Netlify 本番デプロイ手順 |
| [RELEASE_PROCEDURE.md](./operations/develop/RELEASE_PROCEDURE.md) | リリース時の真値ファイル更新手順 (CHANGELOG / お知らせ / version / リリース日) + チェックリスト |
| [DB_MIGRATION_PROCEDURE.md](./operations/develop/DB_MIGRATION_PROCEDURE.md) | Prisma migration の作成・適用・戦略 |
| [SETUP_LOCAL.md](./operations/develop/SETUP_LOCAL.md) | ローカル開発環境の起動手順 + トラブルシューティング |
| [SEED_DATA_MAINTENANCE.md](./operations/develop/SEED_DATA_MAINTENANCE.md) | シードデータの維持・更新ガイド |
| [FAQ_AND_OWL_CHAT_GUIDE.md](./operations/develop/FAQ_AND_OWL_CHAT_GUIDE.md) | FAQ / たすきフクロウ AI チャットのコンテンツ拡充ガイド |
| [REFERENCE.md](./operations/develop/REFERENCE.md) | 設計原則のリマインダ + FAQ + 改修履歴 changelog |

#### [operations/operate/](./operations/operate/) — 運用業務 (本番運用)

障害対応・課金運用・滞納対応・セキュリティ運用・バックアップ・Cron・顧客 FB など、稼働中サービスを回す運用者の手順。

| ファイル | 内容 |
|---|---|
| [INCIDENT_RESPONSE.md](./operations/operate/INCIDENT_RESPONSE.md) | 障害対応 SOP (10 シナリオ) + 重大度分類 + post-mortem テンプレ |
| [MAINTENANCE_OPERATIONS.md](./operations/operate/MAINTENANCE_OPERATIONS.md) | 定常メンテナンス運用手順 |
| [ADMIN_DASHBOARD.md](./operations/operate/ADMIN_DASHBOARD.md) | super_admin 管理ダッシュボードの運用ガイド (監視指標・操作手順) |
| [CRON.md](./operations/operate/CRON.md) | 外部 cron (cron-job.org) スケジュール + 死活監視 |
| [BILLING_MONTHLY_OPERATIONS.md](./operations/operate/BILLING_MONTHLY_OPERATIONS.md) | 月次請求業務運用ガイド (super_admin 向け) |
| [PAYMENT_DELINQUENCY_SOP.md](./operations/operate/PAYMENT_DELINQUENCY_SOP.md) | 支払い滞納時の super_admin 手順書 |
| [STRIPE_WEBHOOK_EVENTS.md](./operations/operate/STRIPE_WEBHOOK_EVENTS.md) | Stripe Webhook イベントの処理仕様・運用対応 |
| [SECURITY_OPS.md](./operations/operate/SECURITY_OPS.md) | 運用上のセキュリティ手順 |
| [SECURITY_ASSESSMENT.md](./operations/operate/SECURITY_ASSESSMENT.md) | セキュリティ評価手順・記録 |
| [DEPENDENCY_VULNERABILITY_PROCESS.md](./operations/operate/DEPENDENCY_VULNERABILITY_PROCESS.md) | 依存パッケージ脆弱性対応プロセス + 新規 npm 事前審査 |
| [BACKUP_VERIFICATION.md](./operations/operate/BACKUP_VERIFICATION.md) | バックアップ検証手順 (四半期 + 臨時) |
| [CUSTOMER_FEEDBACK_TRIAGE.md](./operations/operate/CUSTOMER_FEEDBACK_TRIAGE.md) | 顧客 FB トリアージプロセス (6 チャネル統合、P0-P3 SLA、日次/週次/月次ルーチン) |

#### [operations/setup/](./operations/setup/) — 外部サービス再構築

外部サービス (Stripe / Supabase Storage) を一から構築・再構築する初期セットアップ手順。

| ファイル | 内容 |
|---|---|
| [STRIPE_SETUP.md](./operations/setup/STRIPE_SETUP.md) | Stripe Dashboard セットアップ手順 (v1.x 実装前に必須) |
| [SUPABASE_STORAGE_SETUP.md](./operations/setup/SUPABASE_STORAGE_SETUP.md) | Supabase Storage バケット・ポリシーのセットアップ手順 |

#### [operations/post-mortems/](./operations/post-mortems/) — 障害事後分析

実際に発生した障害の post-mortem (恒久対策の記録)。

| ファイル | 内容 |
|---|---|
| [2026-05-28-tenant-id-default-silent-fallthrough.md](./operations/post-mortems/2026-05-28-tenant-id-default-silent-fallthrough.md) | tenant_id DB DEFAULT による Default テナント silent 混入 (ADR-0024) |
| [2026-05-28-csv-import-multiline-data-loss.md](./operations/post-mortems/2026-05-28-csv-import-multiline-data-loss.md) | CSV インポートの複数行データ欠落 |

> 一過性の公開準備物・検証レポート (GO_LIVE_RUNBOOK / PUBLIC_LAUNCH_CHECKLIST / RELEASE_NOTES_v1 / T-03_RELEASE_NOTES / SUGGESTION_ENGINE_VERIFICATION / MULTI_TENANT_USER_MIGRATION_VERIFICATION / TODO_LIST) は [archive/2026-06-01-pre-ops-reorg/](./archive/2026-06-01-pre-ops-reorg/) へ移動済。

### [test/](./test/) — テスト設計書

テスト戦略・E2E カバレッジ・教訓集。

| ファイル | 内容 |
|---|---|
| [README.md](./test/README.md) | test/ ディレクトリ索引 |
| [STRATEGY.md](./test/STRATEGY.md) | テスト戦略 — 自動化と手動テストの役割分担 |
| [E2E_COVERAGE.md](./test/E2E_COVERAGE.md) | E2E カバレッジ一覧 (PR #90 以降 継続更新) |
| [E2E_LESSONS.md](./test/E2E_LESSONS.md) | E2E テスト実装で得られた知見 (累積罠パターン集) |
| [VISUAL_REGRESSION_CHECKLIST.md](./test/VISUAL_REGRESSION_CHECKLIST.md) | 視覚回帰チェックリスト |

### [knowledge/](./knowledge/) — ナレッジ・教訓集

過去の失敗事例と解決パターン (KDD = Knowledge-Driven Development)。

| ファイル | 内容 |
|---|---|
| [README.md](./knowledge/README.md) | knowledge/ ディレクトリ索引 |
| [KDD_PATTERNS.md](./knowledge/KDD_PATTERNS.md) | KDD ナレッジ集 (§5.X+1〜+65 累積、9000+ 行) |

### [adr/](./adr/) — Architecture Decision Record

主要設計判断の理由を時系列でログ化 (現在 31 件)。詳細な索引・Status は [adr/README.md](./adr/README.md) を正とする。

| ファイル | 内容 |
|---|---|
| [README.md](./adr/README.md) | ADR 索引 + 書き方ガイド |
| [TEMPLATE.md](./adr/TEMPLATE.md) | ADR テンプレート (MADR 形式) |
| [0001-multitenant-foundation.md](./adr/0001-multitenant-foundation.md) | マルチテナント基盤を v1 から実装 |
| [0002-tenant-billing-per-api-call.md](./adr/0002-tenant-billing-per-api-call.md) | テナント単位の従量課金モデル (per-API-call、2026-05-15 半額改定) |
| [0003-embedding-based-suggestion-engine.md](./adr/0003-embedding-based-suggestion-engine.md) | Embedding ベース意味検索を提案エンジンに採用 |
| [0004-postgresql-prisma.md](./adr/0004-postgresql-prisma.md) | PostgreSQL 16 + Prisma ORM の採用 |
| [0005-rbac-two-stage-tenant-authorization.md](./adr/0005-rbac-two-stage-tenant-authorization.md) | RBAC + 二段階テナント認可 (Service 層で統一) |
| [0006-stripe-metered-billing-integration.md](./adr/0006-stripe-metered-billing-integration.md) | Stripe Metered Billing 連携 (v1.x) |
| [0007-unify-invoice-and-bank-transfer.md](./adr/0007-unify-invoice-and-bank-transfer.md) | invoice と bank_transfer の支払い方法を統合 |
| [0008-graceful-degradation-mode.md](./adr/0008-graceful-degradation-mode.md) | 縮退モード — ハードカット 429 を採用しない |
| [0009-nextauth-credentials-mfa-totp.md](./adr/0009-nextauth-credentials-mfa-totp.md) | NextAuth.js (Credentials) + MFA (TOTP) を認証基盤に採用 |
| [0010-project-state-machine.md](./adr/0010-project-state-machine.md) | プロジェクト状態マシン (7 状態 + 一方向遷移) |
| [0011-soft-delete-and-audit-log.md](./adr/0011-soft-delete-and-audit-log.md) | 論理削除 + 全変更操作の監査ログ完全記録 |
| [0012-vercel-supabase-mvp-hosting.md](./adr/0012-vercel-supabase-mvp-hosting.md) | Vercel + Supabase 無料枠を MVP 期に採用 (**ADR-0023 で Superseded、Netlify Personal へ移行済**) |
| [0013-beginner-downgrade-prohibition.md](./adr/0013-beginner-downgrade-prohibition.md) | Beginner プランへのダウングレード禁止 (悪用防止) |
| [0014-crud-permission-redesign.md](./adr/0014-crud-permission-redesign.md) | CRUD 設計刷新 — UI=API 認可一致原則 + PM/TL 自律権限 + 自己ロール変更禁止 (2026-05-20) |
| [0015-cascade-delete-idempotent-design.md](./adr/0015-cascade-delete-idempotent-design.md) | deleteProjectCascade / deleteCustomerCascade の冪等設計 + 段階別 transaction (2026-05-20) |
| [0016-multi-tenant-user-membership.md](./adr/0016-multi-tenant-user-membership.md) | User.email を tenant-scoped 一意化 + 組織 ID 明示入力 |
| [0017-wbs-import-uplift-and-task-duplicate.md](./adr/0017-wbs-import-uplift-and-task-duplicate.md) | WBS sync-import 親スコープ重複判定 + OCC + DB UNIQUE + タスク一括複製 + ログイン UX (PR #420) |
| [0018-tenant-identifier-user-visibility.md](./adr/0018-tenant-identifier-user-visibility.md) | テナント識別子のユーザ可視化 + 設定画面の情報分離 |
| [0019-billable-feature-units-and-free-tier-expansion.md](./adr/0019-billable-feature-units-and-free-tier-expansion.md) | 課金対象 featureUnit の明示化と無料利用範囲の拡大 (Partially superseded by 0022) |
| [0020-db-capacity-usage-based-billing.md](./adr/0020-db-capacity-usage-based-billing.md) | DB 容量従量課金 — 月中 peak ベース階段関数型料金 |
| [0021-file-storage-usage-based-billing.md](./adr/0021-file-storage-usage-based-billing.md) | ファイル添付ストレージ従量課金 — Supabase Storage 連携 |
| [0022-embedding-usage-based-billing.md](./adr/0022-embedding-usage-based-billing.md) | Embedding 機能の従量課金 (単価は ADR-0029 で ¥5 に改定) |
| [0023-netlify-starter-migration.md](./adr/0023-netlify-starter-migration.md) | Vercel Hobby → Netlify (Starter → Personal) 移行 (ADR-0012 を Supersede) |
| [0024-explicit-tenant-id-no-db-default.md](./adr/0024-explicit-tenant-id-no-db-default.md) | tenant_id カラムから DB DEFAULT を撤去しコード明示必須化 (severity-1 silent fall-through 対応) |
| [0025-beginner-write-guard.md](./adr/0025-beginner-write-guard.md) | Beginner プランの DB / File Storage 無料枠超過時 write ブロック |
| [0026-embedding-async-generation.md](./adr/0026-embedding-async-generation.md) | 資産作成・更新時の embedding 生成を非同期化 (Next.js `after()` 採用) |
| [0027-help-ai-concierge.md](./adr/0027-help-ai-concierge.md) | たすきフクロウ AI ヘルプチャット (FAQ コンシェルジュ) の導入 (Superseded by 0028) |
| [0028-help-chat-rag-migration.md](./adr/0028-help-chat-rag-migration.md) | たすきフクロウ AI ヘルプチャットを full-context から RAG (Voyage embedding) へ移行 |
| [0029-embedding-price-revision-5jpy.md](./adr/0029-embedding-price-revision-5jpy.md) | Embedding 従量課金の単価改定 — Expert/Pro ¥1 → ¥5/call |
| [0030-embedding-monthly-budget-cap.md](./adr/0030-embedding-monthly-budget-cap.md) | Embedding 月次予算上限の導入 + Beginner Embedding 100 件試用上限 + 請求タブ「今月請求金額」 (§6 で DB/Storage 累積ハードキャップ撤廃を追記) |
| [0031-footer-auth-aware-and-about-removal.md](./adr/0031-footer-auth-aware-and-about-removal.md) | フッター認証出し分け (2 層) + `/settings/about` 廃止 + 共通情報の外部 LP 集約 |

### 今後のロードマップ — [operations/ROADMAP.md](./operations/ROADMAP.md)

未実装かつ運用保守に必要な計画の living 集約先は [operations/ROADMAP.md](./operations/ROADMAP.md)（運用保守ロードマップ）。

> 旧 `roadmap/` ディレクトリは 2026-06-01 に全廃し、[archive/2026-06-01-pre-ops-reorg/roadmap/](./archive/2026-06-01-pre-ops-reorg/roadmap/)（RELEASE_ROADMAP.md / STRIPE_INTEGRATION_PLAN.md / future/）へ移動。未実装計画は operations/ROADMAP.md に無損失移植済。
> 実装完了済の plan (V1_FINAL_TASKS / SUGGESTION_ENGINE_PLAN / ROLE_REFACTORING_PLAN) は 2026-05-19 に [archive/roadmap/](./archive/roadmap/) へ移動済。
> v2 構想だった CHAT_SEMANTIC_SEARCH は実装・正式仕様化され [specification/CHAT_SEMANTIC_SEARCH.md](./specification/CHAT_SEMANTIC_SEARCH.md) へ昇格済。

### [security/](./security/) — セキュリティ設計・運用

脅威モデル + STRIDE 手順 + セキュリティタスク。

| ファイル | 内容 |
|---|---|
| [README.md](./security/README.md) | security/ ディレクトリ索引 + CI 統合 7 系統の解説 |
| [STRIDE_REVIEW_PROCEDURE.md](./security/STRIDE_REVIEW_PROCEDURE.md) | STRIDE 脅威モデリング 実施手順 (四半期定期 + 臨時) |
| [SUGGESTION_ENGINE_THREAT_MODEL.md](./security/SUGGESTION_ENGINE_THREAT_MODEL.md) | 提案エンジンの脅威モデル (STRIDE 分析結果) |
| [PHASE2_THREAT_MODEL.md](./security/PHASE2_THREAT_MODEL.md) | Phase 2 機能の脅威モデル |
| [TENANT_ISOLATION_PHASE2_TODO.md](./security/TENANT_ISOLATION_PHASE2_TODO.md) | テナント越境バグ Phase 2 残課題 (severity-1) |
| [SECURITY-TASKS.md](./security/SECURITY-TASKS.md) | セキュリティタスク (F-01 等、後続対応リスト) |

### [vision/](./vision/) — 思想・価値観

意思決定のコンパス。

| ファイル | 内容 |
|---|---|
| [README.md](./vision/README.md) | Vision / 思想・価値観 — なぜ作るのか / 大切にする価値観 / 長期展望 / 一緒に作りたい人 |

### [public/](./public/) — 外部ユーザ向け公開ドキュメント

リリース時に外部公開する利用者向け手順書。

| ファイル | 内容 |
|---|---|
| [README.md](./public/README.md) | public/ ディレクトリ索引 |
| [about.md](./public/about.md) | サービス紹介 (利用者向け) |
| [account-setup-guide.md](./public/account-setup-guide.md) | アカウント追加手順 (利用者向け) |

### [archive/](./archive/) — アーカイブ

完了済イベントの記録 / 履歴保全 (現役運用では参照しない)。

| サブディレクトリ | 内容 |
|---|---|
| [README.md](./archive/README.md) | archive/ 索引 + archive 基準 + Future archive plan (Phase 2-3 トリガ条件) |
| [performance/20260417/](./archive/performance/20260417/) | 2026-04 パフォーマンス改修プロジェクトの記録 (4 ファイル) |
| [roadmap/MVP_HISTORICAL.md](./archive/roadmap/MVP_HISTORICAL.md) | MVP 構築計画 (2026-04-15 完了時点の履歴記録) |
| [audits/RESPONSIVE_AUDIT.md](./archive/audits/RESPONSIVE_AUDIT.md) | PR #128 レスポンシブ監査レポート |
| [2026-06-01-pre-ops-reorg/](./archive/2026-06-01-pre-ops-reorg/) | operations/ 再編で退避した一過性物 (GO_LIVE_RUNBOOK / PUBLIC_LAUNCH_CHECKLIST / RELEASE_NOTES_v1 / T-03_RELEASE_NOTES / SUGGESTION_ENGINE_VERIFICATION / MULTI_TENANT_USER_MIGRATION_VERIFICATION / TODO_LIST、7 ファイル) |

---

## リポジトリトップのドキュメント

`docs/` 外にも以下の重要ドキュメントが存在します。

| ファイル | 内容 |
|---|---|
| [../README.md](../README.md) | プロダクト概要・機能一覧・技術スタック (リファレンス) |
| [../ONBOARDING.md](../ONBOARDING.md) | **環境構築から PR・CI まで自己完結** (新規参入者の最初の入口) |
| [../CONTRIBUTING.md](../CONTRIBUTING.md) | コミット / PR 規約 + コードレビュー観点 10 項目 |
| [../CLAUDE.md](../CLAUDE.md) | Claude Code 運用ガイド (緊急時のみ利用) |
| [../SECURITY.md](../SECURITY.md) | 脆弱性報告窓口 (public-facing) |
| [../LICENSE](../LICENSE) | AGPL-3.0 ライセンス全文 (GNU 公式) |
| [../scripts/README.md](../scripts/README.md) | 補助スクリプト索引 (CI/品質 / 開発・Seed / 運用・緊急対応) |
| [../e2e/README.md](../e2e/README.md) | E2E テストガイド (人間向け) |

---

## ドキュメント分割の経緯

2026-05-02 までは単一の巨大ドキュメント (DEVELOPER_GUIDE.md 6600 行 / DESIGN.md 4800 行 など) に内容を累積していた。PR ごとに知見を追記し続けた結果、検索性と単一責務性が大きく低下していたため、役割別の小さなドキュメントに分散させ、保守性と発見性を改善した。

2026-05-17 にさらに整理を実施:
- 旧 `docs/beginner/README.md` の重複コンテンツを [ONBOARDING.md](../ONBOARDING.md) と [design/ARCHITECTURE.md §4](./design/ARCHITECTURE.md) に統合・削除
- 完了済イベントの記録を [archive/](./archive/) に集約
- v2 以降の将来構想を `roadmap/future/` に分離 (2026-06-01 に全廃、[archive/2026-06-01-pre-ops-reorg/roadmap/future/](./archive/2026-06-01-pre-ops-reorg/roadmap/future/) へ移動)
- 主要テーマ (Stripe / 提案エンジン) の横断索引を [business/README.md](./business/README.md) に追加

### 新規追記のルール

新規追記は本ディレクトリ構造に従う:

- 「**どこに書けばいいか分からない**」場合は [knowledge/](./knowledge/) に一旦書き、後で適切なディレクトリへ移す
- **後戻りコストが高い設計判断** を伴う変更は [adr/](./adr/) に新規 ADR を追加
- **完了済イベント** (リリースノート / 検証レポート等) は時期を見て [archive/](./archive/) へ移動
- **未実装かつ運用保守に必要な計画 / v2 以降の構想** は [operations/ROADMAP.md](./operations/ROADMAP.md)（運用保守ロードマップ）に追記する。実装・正式仕様化したら [specification/](./specification/) へ昇格
- 新規ファイル追加時は **本 README の該当ディレクトリの表に 1 行追加** すること

詳細な追加ルール: 各ディレクトリの README.md を参照。
