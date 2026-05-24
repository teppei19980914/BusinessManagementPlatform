# operations/ — 運用・移行手順書

本ディレクトリは、本サービスの **運用手順 (デプロイ・障害対応・DB マイグレーション・Cron) と移行計画 (AWS / Azure / GCP)** を集約する。

## ファイル一覧

| ファイル | 内容 | 元の所在 |
|---|---|---|
| [ENV_VARS.md](./ENV_VARS.md) | 全環境変数の一覧と説明 | OPERATION.md §1 |
| [SETUP_LOCAL.md](./SETUP_LOCAL.md) | ローカル開発環境の起動手順 | OPERATION.md §2 |
| [DB_MIGRATION_PROCEDURE.md](./DB_MIGRATION_PROCEDURE.md) | Prisma migration の作成・適用・適用済み一覧・戦略 | OPERATION.md §3-§4 + DESIGN.md §14 |
| [DEPLOYMENT.md](./DEPLOYMENT.md) | Vercel 本番デプロイ手順 | OPERATION.md §5 |
| [INCIDENT_RESPONSE.md](./INCIDENT_RESPONSE.md) | 障害対応・ロールバック手順 | OPERATION.md §6-§7 |
| [PAYMENT_DELINQUENCY_SOP.md](./PAYMENT_DELINQUENCY_SOP.md) | 支払い滞納時の super_admin 手順書 (リマインダー文面 / read-only 移行 SQL / 内容証明 / 削除と債権放棄) | 新規 (2026-05-09) |
| [BILLING_MONTHLY_OPERATIONS.md](./BILLING_MONTHLY_OPERATIONS.md) | 月次請求業務の super_admin オペレーション (CSV エクスポート / 解約済込み出力 / 月途中解約の請求検知) | 新規 (2026-05-14) |
| [STRIPE_SETUP.md](./STRIPE_SETUP.md) | Stripe Dashboard 事前セットアップ手順 (Product / Price / Webhook / Tax / API キー、v1.x 実装前に必須) | 新規 (2026-05-14) |
| [CRON.md](./CRON.md) | Vercel Cron + cron-job.org ウォームアップ + ヘルスチェック + 死活監視 | OPERATION.md §8-§11 |
| [SECURITY_OPS.md](./SECURITY_OPS.md) | 運用上のセキュリティ手順 | OPERATION.md §13 |
| [SECURITY_ASSESSMENT.md](./SECURITY_ASSESSMENT.md) | OWASP Top 10 観点でのセキュリティ実装状況スナップショット + 四半期再評価手順 + ペネトレーションテスト推奨 | 新規 (2026-05-20 / PR #415) |
| [MIGRATION_TO_AWS.md](./MIGRATION_TO_AWS.md) | Vercel + Supabase から AWS / Azure / GCP への将来的移行計画 | DESIGN.md §34.13 |
| [CUSTOMER_FEEDBACK_TRIAGE.md](./CUSTOMER_FEEDBACK_TRIAGE.md) | 顧客フィードバック トリアージプロセス (6 チャネル → GitHub Issues 集約、P0-P3 SLA、日次/週次/月次ルーチン) | 新規 (2026-05-16) |
| [BACKUP_VERIFICATION.md](./BACKUP_VERIFICATION.md) | バックアップ検証手順 (四半期 + 臨時、Supabase/Vercel/Storage/環境変数の復元可能性確認) | 新規 (2026-05-16) |
| [DEPENDENCY_VULNERABILITY_PROCESS.md](./DEPENDENCY_VULNERABILITY_PROCESS.md) | 依存パッケージ脆弱性対応プロセス (3 系統検知 / 重要度別 SLA / 対応方式 4 種 / 新規 npm 事前審査) | 新規 (2026-05-16) |
| [DOGFOODING_PLAN.md](./DOGFOODING_PLAN.md) | Dogfooding 計画 (6/15 ± 1 週、AI 補助なし機能実装によるドキュメント検証) | 新規 (2026-05-16) |
| [RELEASE_NOTES_v1.md](./RELEASE_NOTES_v1.md) | v1.0 リリースノート (ドラフト、5/30 確定版へ) | 新規 (2026-05-16) |
| [GO_LIVE_RUNBOOK.md](./GO_LIVE_RUNBOOK.md) | 6/1 公開当日の時系列手順 (T-2 週 〜 T+1 営業日) + ロールバック条件 + B4 判断 | 新規 (2026-05-16) |
| [PUBLIC_LAUNCH_CHECKLIST.md](./PUBLIC_LAUNCH_CHECKLIST.md) | 公開前チェックリスト (法的書類 LICENSE/利用規約/プライバシーポリシー、公開ページ /login 案内/OG画像/robots.txt、運用準備) | 新規 (2026-05-19) |
| [RELEASE_PROCEDURE.md](./RELEASE_PROCEDURE.md) | リリース時の真値ファイル一覧 (CHANGELOG / お知らせ / version / リリース日) + 手順チェックリスト + severity 使い分け | 新規 (2026-05-24 / PR #439) |
