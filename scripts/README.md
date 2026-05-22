# scripts/ — 補助スクリプト索引

本ディレクトリの TypeScript スクリプトは、`tsx` で直接実行する補助ツール群。
パスを変更すると CI ワークフロー / package.json / 各種ドキュメントから参照されている箇所に影響するため、**ファイル配置はフラットのまま、本 README で役割別に分類**する。

---

## 役割別索引

### CI / 品質ゲート (自動実行が中心)

| スクリプト | 用途 | 実行コマンド | 主な参照元 |
|---|---|---|---|
| [check-e2e-coverage.ts](./check-e2e-coverage.ts) | 新規 `page.tsx` / `route.ts` の E2E カバレッジ漏れ検出 | `pnpm e2e:coverage-check` | `.github/workflows/ci.yml`、PR レビュー時の手動実行 |
| [security-check.ts](./security-check.ts) | プロジェクト固有設計パターンの回帰検査 (callbackUrl / SameSite / Rate-limit / CSP 等) + pnpm audit live。スコア化して 90/100 を CI で強制 | `pnpm security:check` / `pnpm security:gate` | `.github/workflows/security.yml` Security Score Gate ジョブ |
| [i18n-extract-hardcoded-ja.ts](./i18n-extract-hardcoded-ja.ts) | UI 文字列のハードコード検出 (i18n 移行の進捗確認) | `tsx scripts/i18n-extract-hardcoded-ja.ts` | i18n 整理時の手動実行 |

### 開発 / Seed (開発時の手動実行)

| スクリプト | 用途 | 実行コマンド | 関連ドキュメント |
|---|---|---|---|
| [generate-seed-embeddings.ts](./generate-seed-embeddings.ts) | Seed データの embedding 一括生成 (Voyage API 呼出) | `pnpm seed:generate-embeddings` | [docs/developer-guide/SEED_DATA_MAINTENANCE.md](../docs/developer-guide/SEED_DATA_MAINTENANCE.md) |
| [check-seed-length.ts](./check-seed-length.ts) | Seed データの文字列長が DB 制約に違反していないか検査 | `tsx scripts/check-seed-length.ts` | [docs/developer-guide/SEED_DATA_MAINTENANCE.md](../docs/developer-guide/SEED_DATA_MAINTENANCE.md) |
| [print-migration.ts](./print-migration.ts) | 指定 migration の SQL 差分を出力 (適用前の確認用) | `pnpm migrate:print <name>` | [docs/operations/DB_MIGRATION_PROCEDURE.md](../docs/operations/DB_MIGRATION_PROCEDURE.md) |

### 運用 / 緊急対応 (本番運用時のみ手動実行)

| スクリプト | 用途 | 実行コマンド | 想定シナリオ |
|---|---|---|---|
| [recover-prisma-migrations.ts](./recover-prisma-migrations.ts) | 失敗した migration の `_prisma_migrations` テーブル不整合を復旧 | `pnpm db:recover` | migration の途中で fail した場合、または `relation already exists` (42P07) が出た場合 ([docs/operations/DB_MIGRATION_PROCEDURE.md](../docs/operations/DB_MIGRATION_PROCEDURE.md)) |
| [cleanup-orphan-user.ts](./cleanup-orphan-user.ts) | テナント削除時に残った孤立ユーザを物理削除 | `tsx scripts/cleanup-orphan-user.ts` | テナント削除運用後の整合性チェック |

### Stripe / TC 検証 (staging/dev 専用、PR #425 で追加)

| スクリプト | 用途 | 実行コマンド | 想定シナリオ |
|---|---|---|---|
| [check-tenants.ts](./check-tenants.ts) | 全テナント + 全ユーザの一覧 (slug / role / email / tenantId) を表示 | `tsx scripts/check-tenants.ts` | テナント slug / super_admin email の確認、ユーザ越境状況の調査 |
| [check-tenant-stripe-state.ts](./check-tenant-stripe-state.ts) | default テナントの Stripe 関連フィールド (plan / paymentMethod / stripeCustomerId / stripeSubscriptionId / cardVerificationStatus 等) を表示 | `tsx scripts/check-tenant-stripe-state.ts` | TC 実施中の DB 状態確認 (= 「画面 = 請求カード」の DB 側裏付け検証) |
| [reset-default-tenant-to-beginner.ts](./reset-default-tenant-to-beginner.ts) | default テナントを Beginner プラン + 銀行振込 + Stripe 関連全クリアに **完全初期化** (= TC やり直し用) | `tsx scripts/reset-default-tenant-to-beginner.ts` | TC-1 / TC-2 / TC-3 等を最初からやり直したい時。stripeCustomerId は保持 (= 再 setup で既存 Customer 再利用) |

**注意**:
- 上記 Stripe 系 script は **staging / dev 環境専用**。本番 DB に対しては絶対実行しないこと
- `DATABASE_URL` / `DIRECT_URL` を staging Supabase の Connection string に切り替えてから実行する
- 詳細は [docs/test/STRIPE_PAYMENT_TEST_PROCEDURE.md](../docs/test/STRIPE_PAYMENT_TEST_PROCEDURE.md) §4.1 (事前準備) 参照

---

## 新規スクリプト追加時のルール

1. **配置**: `scripts/<kebab-case>.ts` のフラット配置 (サブディレクトリは作らない)
2. **package.json へのエントリ**: 頻繁に実行するなら `pnpm <prefix>:<action>` 形式の short alias を追加
3. **本 README への追記**: 上記 3 カテゴリのいずれかに 1 行追加 (用途・実行コマンド・参照元)
4. **依存関係**: Prisma client や process.env を使う場合、`.env` の読み込みを冒頭で行う (例: 既存スクリプト参照)
5. **本番影響あり** (DB 書込・外部 API 呼出) の場合:
   - 冒頭で `process.env.NODE_ENV` / `process.env.DATABASE_URL` を確認するガードを書く
   - dry-run オプションを既定にし、`--apply` 等の明示フラグで実行
   - 監査ログを残す (どのスクリプトで何件処理したか)

---

## 関連ドキュメント

- DB 操作系: [docs/operations/DB_MIGRATION_PROCEDURE.md](../docs/operations/DB_MIGRATION_PROCEDURE.md)
- Seed メンテ: [docs/developer-guide/SEED_DATA_MAINTENANCE.md](../docs/developer-guide/SEED_DATA_MAINTENANCE.md)
- セキュリティチェック仕組み全体: [docs/security/README.md](../docs/security/README.md)
- インシデント対応 SOP: [docs/operations/INCIDENT_RESPONSE.md](../docs/operations/INCIDENT_RESPONSE.md)
