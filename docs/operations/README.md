# operations/ — 運用保守ドキュメント トップ索引

## 本ディレクトリの位置づけ

本ディレクトリは、本サービス (たすきば Knowledge Relay) の **運用・保守・開発に関する手順書を集約する一本化されたトップ索引** です。

- **開発モード (2026-06-01 以降)**: 人間駆動開発。AI 補助なしでも全工程を再現できる粒度で記述しています。
- **統合の経緯**: 旧 `developer-guide/` を本ディレクトリに **吸収統合** し、シナリオ別サブディレクトリへ再構成しました。
- **サブディレクトリの役割**:
  - [`develop/`](./develop/) — **開発作業** (機能を作る・直す・テスト・デプロイするとき)
  - [`operate/`](./operate/) — **日々の運用業務** (障害対応・課金運用・セキュリティ運用・管理画面操作)
  - [`setup/`](./setup/) — **再構築・初期セットアップ** (外部サービスの初期設定)
  - [`post-mortems/`](./post-mortems/) — **障害事後分析** (恒久保管)
  - 直下 — ディレクトリ横断・移行計画・tombstone

---

## 目的別の入口

| やりたいこと | まず読む |
|---|---|
| 開発の全体フローを把握したい | [develop/DEVELOPMENT_FLOW.md](./develop/DEVELOPMENT_FLOW.md) |
| 新しい機能・画面を追加したい | [develop/HOW_TO_ADD_FEATURES.md](./develop/HOW_TO_ADD_FEATURES.md) |
| 既存機能を修正したい | [develop/MODIFY_FEATURE.md](./develop/MODIFY_FEATURE.md) |
| デプロイしたい | [develop/DEPLOYMENT.md](./develop/DEPLOYMENT.md) + [develop/COMMIT_AND_DEPLOY.md](./develop/COMMIT_AND_DEPLOY.md) |
| 障害が発生した | [operate/INCIDENT_RESPONSE.md](./operate/INCIDENT_RESPONSE.md) |
| 運用業務の全体像を知りたい | [operate/MAINTENANCE_OPERATIONS.md](./operate/MAINTENANCE_OPERATIONS.md) |
| 管理者画面 (super_admin) を運用したい | [operate/ADMIN_DASHBOARD.md](./operate/ADMIN_DASHBOARD.md) |
| 月次請求業務を行いたい | [operate/BILLING_MONTHLY_OPERATIONS.md](./operate/BILLING_MONTHLY_OPERATIONS.md) |
| 外部サービスを初期構築したい | [setup/STRIPE_SETUP.md](./setup/STRIPE_SETUP.md) + [setup/SUPABASE_STORAGE_SETUP.md](./setup/SUPABASE_STORAGE_SETUP.md) |
| 環境変数を調べたい | [docs/design/ENVIRONMENT_VARIABLES.md](../design/ENVIRONMENT_VARIABLES.md) (ENV_VARS.md は移転済) |
| 今後のロードマップ・未実装の整備計画を知りたい | [ROADMAP.md](./ROADMAP.md) (運用保守ロードマップ) |

---

## develop/ — 開発作業 (機能を作る・直すとき)

| ファイル | 内容 |
|---|---|
| [develop/DEVELOPMENT_FLOW.md](./develop/DEVELOPMENT_FLOW.md) | 着手 → リリースまでの開発全工程を 1 枚で示す手順書 (人間駆動開発前提) |
| [develop/HOW_TO_ADD_FEATURES.md](./develop/HOW_TO_ADD_FEATURES.md) | 新規画面・機能・テーマカラー・マスタデータの追加手順 (削除手順含む §6) |
| [develop/MODIFY_FEATURE.md](./develop/MODIFY_FEATURE.md) | 既存機能改修の調査・流用・横展開・退行防止 (grep 4 軸 / 影響範囲特定) |
| [develop/LOCAL_TEST_GUIDE.md](./develop/LOCAL_TEST_GUIDE.md) | ローカル単体テストの効率的な書き方・mock パターン・典型的な罠 |
| [develop/E2E_TEST_GUIDE.md](./develop/E2E_TEST_GUIDE.md) | Playwright E2E テストの実装 Tips とカバレッジ維持手順 |
| [develop/SECURITY_CHECK_GUIDE.md](./develop/SECURITY_CHECK_GUIDE.md) | セキュリティチェック CI で PR が弾かれた時の対処と失敗パターン → 修正方法 |
| [develop/TEST_LINT_BUILD.md](./develop/TEST_LINT_BUILD.md) | 開発時のテスト・lint・build 実行方法 |
| [develop/COMMIT_AND_DEPLOY.md](./develop/COMMIT_AND_DEPLOY.md) | コミット・PR 作成・デプロイのワークフロー (DB スキーマ変更手順含む) |
| [develop/DEPLOYMENT.md](./develop/DEPLOYMENT.md) | Netlify 本番デプロイ手順 |
| [develop/RELEASE_PROCEDURE.md](./develop/RELEASE_PROCEDURE.md) | リリース時の真値ファイル一覧 (CHANGELOG / お知らせ / version) + 手順チェックリスト + severity 使い分け |
| [develop/DB_MIGRATION_PROCEDURE.md](./develop/DB_MIGRATION_PROCEDURE.md) | Prisma migration の作成・適用・適用済み一覧・戦略 |
| [develop/SETUP_LOCAL.md](./develop/SETUP_LOCAL.md) | ローカル開発環境の起動手順 |
| [develop/SEED_DATA_MAINTENANCE.md](./develop/SEED_DATA_MAINTENANCE.md) | 提案エンジンのシードデータ変更手順 + 「提案で拾われやすい」文章ガイドライン |
| [develop/FAQ_AND_OWL_CHAT_GUIDE.md](./develop/FAQ_AND_OWL_CHAT_GUIDE.md) | FAQ コンテンツとたすきフクロウ AI チャットのしくみ / FAQ 追加時の注意点 / 回答精度向上のコツ |
| [develop/REFERENCE.md](./develop/REFERENCE.md) | 開発時に立ち返るべき設計原則とよくある質問 |

---

## operate/ — 日々の運用業務

| ファイル | 内容 |
|---|---|
| [operate/MAINTENANCE_OPERATIONS.md](./operate/MAINTENANCE_OPERATIONS.md) | **運用業務カタログ (中核)**: super_admin の定常業務 / アドホック業務を一覧化した索引 |
| [operate/INCIDENT_RESPONSE.md](./operate/INCIDENT_RESPONSE.md) | 障害対応・ロールバック手順 |
| [operate/BILLING_MONTHLY_OPERATIONS.md](./operate/BILLING_MONTHLY_OPERATIONS.md) | 月次請求業務の super_admin オペレーション (CSV エクスポート / 解約済込み出力 / 月途中解約の請求検知) |
| [operate/PAYMENT_DELINQUENCY_SOP.md](./operate/PAYMENT_DELINQUENCY_SOP.md) | 支払い滞納時の super_admin 手順書 (リマインダー文面 / read-only 移行 SQL / 内容証明 / 削除と債権放棄) |
| [operate/STRIPE_WEBHOOK_EVENTS.md](./operate/STRIPE_WEBHOOK_EVENTS.md) | Stripe から受信する 11 個の Webhook イベントの発生条件 / 処理 / ビジネス影響リファレンス |
| [operate/SECURITY_OPS.md](./operate/SECURITY_OPS.md) | 運用上のセキュリティ手順 |
| [operate/SECURITY_ASSESSMENT.md](./operate/SECURITY_ASSESSMENT.md) | OWASP Top 10 観点でのセキュリティ実装状況スナップショット + 四半期再評価手順 + ペネトレーションテスト推奨 |
| [operate/DEPENDENCY_VULNERABILITY_PROCESS.md](./operate/DEPENDENCY_VULNERABILITY_PROCESS.md) | 依存パッケージ脆弱性対応プロセス (3 系統検知 / 重要度別 SLA / 対応方式 4 種 / 新規 npm 事前審査) |
| [operate/BACKUP_VERIFICATION.md](./operate/BACKUP_VERIFICATION.md) | バックアップ検証手順 (四半期 + 臨時、Supabase/Netlify/Storage/環境変数の復元可能性確認) |
| [operate/CRON.md](./operate/CRON.md) | 外部 cron (cron-job.org) スケジュール + ヘルスチェック + 死活監視 |
| [operate/CUSTOMER_FEEDBACK_TRIAGE.md](./operate/CUSTOMER_FEEDBACK_TRIAGE.md) | 顧客フィードバック トリアージプロセス (6 チャネル → GitHub Issues 集約、P0-P3 SLA、日次/週次/月次ルーチン) |
| [operate/ADMIN_DASHBOARD.md](./operate/ADMIN_DASHBOARD.md) | システム管理者ダッシュボード (`/admin/super` 配下 全 12 画面) の運用説明 (super_admin が日々どう使うか) |

---

## setup/ — 再構築・初期セットアップ

| ファイル | 内容 |
|---|---|
| [setup/STRIPE_SETUP.md](./setup/STRIPE_SETUP.md) | Stripe Dashboard 事前セットアップ手順 (Product / Price / Webhook / Tax / API キー) |
| [setup/SUPABASE_STORAGE_SETUP.md](./setup/SUPABASE_STORAGE_SETUP.md) | Supabase Storage Bucket の作成・RLS Policy 設定手順 (ファイル添付従量課金 ADR-0021 用) |

---

## post-mortems/ — 障害事後分析 (恒久保管)

| ファイル | 内容 |
|---|---|
| [post-mortems/2026-05-28-tenant-id-default-silent-fallthrough.md](./post-mortems/2026-05-28-tenant-id-default-silent-fallthrough.md) | S-1: tenant_id DB DEFAULT による silent テナント越境バグ (2026-04-15 〜 2026-05-28) |
| [post-mortems/2026-05-28-csv-import-multiline-data-loss.md](./post-mortems/2026-05-28-csv-import-multiline-data-loss.md) | S-high: CSV 上書きインポートで quoted multi-line cell の 2 行目以降が silent 欠落 |

---

## 直下据置 — ディレクトリ横断・移行計画

| ファイル | 内容 |
|---|---|
| [ROADMAP.md](./ROADMAP.md) | **運用保守ロードマップ** (未実装の整備計画・将来機能の living 集約先。旧 `roadmap/` 全廃に伴い未実装計画を無損失移植) |
| [ENV_VARS.md](./ENV_VARS.md) | **移転済 tombstone** → 正は [docs/design/ENVIRONMENT_VARIABLES.md](../design/ENVIRONMENT_VARIABLES.md) (既存リンク互換のため残置) |
| [MIGRATION_TO_AWS.md](./MIGRATION_TO_AWS.md) | Netlify + Supabase から AWS / Azure / GCP への将来的移行計画 |
| [DOGFOODING_PLAN.md](./DOGFOODING_PLAN.md) | Dogfooding 計画 (AI 補助なし機能実装によるドキュメント検証) |

---

## アーカイブ済 — 一過性ドキュメント

以下の一過性ドキュメント (6/1 公開準備・特定リリース時の検証記録など) は、運用保守ディレクトリの再構成 (2026-06-01) に伴い [`../archive/2026-06-01-pre-ops-reorg/`](../archive/2026-06-01-pre-ops-reorg/) へ退避しました。経緯参照用として保管しています。

| アーカイブ先 | 内容 |
|---|---|
| [GO_LIVE_RUNBOOK.md](../archive/2026-06-01-pre-ops-reorg/GO_LIVE_RUNBOOK.md) | 6/1 公開当日の時系列手順 (T-2 週 〜 T+1 営業日) + ロールバック条件 |
| [PUBLIC_LAUNCH_CHECKLIST.md](../archive/2026-06-01-pre-ops-reorg/PUBLIC_LAUNCH_CHECKLIST.md) | 公開前チェックリスト (法的書類 / 公開ページ / 運用準備) |
| [RELEASE_NOTES_v1.md](../archive/2026-06-01-pre-ops-reorg/RELEASE_NOTES_v1.md) | v1.0 リリースノート |
| [T-03_RELEASE_NOTES.md](../archive/2026-06-01-pre-ops-reorg/T-03_RELEASE_NOTES.md) | T-03 リリースノート |
| [SUGGESTION_ENGINE_VERIFICATION.md](../archive/2026-06-01-pre-ops-reorg/SUGGESTION_ENGINE_VERIFICATION.md) | 提案エンジン検証記録 |
| [MULTI_TENANT_USER_MIGRATION_VERIFICATION.md](../archive/2026-06-01-pre-ops-reorg/MULTI_TENANT_USER_MIGRATION_VERIFICATION.md) | マルチテナント ユーザ移行検証記録 |
