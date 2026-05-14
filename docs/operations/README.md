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
| [CRON.md](./CRON.md) | Vercel Cron + cron-job.org ウォームアップ + ヘルスチェック + 死活監視 | OPERATION.md §8-§11 |
| [SECURITY_OPS.md](./SECURITY_OPS.md) | 運用上のセキュリティ手順 | OPERATION.md §13 |
| [MIGRATION_TO_AWS.md](./MIGRATION_TO_AWS.md) | Vercel + Supabase から AWS / Azure / GCP への将来的移行計画 | DESIGN.md §34.13 |
