# ADR-0021 ハンドオフ: ファイル添付ストレージ従量課金 + Attachment Embedding

> **作成**: 2026-05-26 (前セッション終了時)
> **ブランチ**: `feat/file-storage-usage-based-billing` (未 commit、ローカル変更のみ)
> **状況**: 基盤層完成 (7/43 タスク)、残 ~17 タスク。フルテスト 3289/3289 PASS。

---

## 次セッション開始時に貼り付けるプロンプト

下記をコピーして次回セッションの最初のメッセージに貼ってください:

```
ADR-0021 (ファイル添付ストレージ従量課金 + Attachment Embedding) の実装を継続します。

前セッションで基盤層 (config / migration / schema / 2 service / 1 doc / Stripe 定数 / api-usage-guide) を完成済 (フルテスト 3289/3289 PASS、ブランチ未 commit)。

詳細は HANDOFF_ADR_0021.md と memory/project_adr_0021_in_progress.md を読んでください。

このセッションでは以下を「動作保証付き」で完成させたい:

1. まず `pnpm install` で次セッション必須の packages (pdf-parse / xlsx / mammoth / @types/pdf-parse) を入れる
2. P3 サービス層 (upload-api / embedding-cron / storage-guard / bucket-calc / attachment-service / chat-search / suggestion-engine / anomaly) を順次実装 + テスト
3. P4-P6 (cron + withdrawal + Stripe callType) を実装 + テスト
4. P11 品質ゲート (lint/tsc/test/e2e:coverage/build) を全 green に
5. P12 commit + PR 作成

UI (P7) と 残 docs (P8) は別 PR (PR-C) に切り分けて、本セッションでは PR-B 完成を最優先にしてください。1 セッションで全完走しようとせず、PR-B が green に出来た段階で commit + PR まで進めて区切る。

P7/P8 残作業は次回 PR-C で。
```

---

## 完了済 (本セッション内、動作保証あり)

### コード
| ファイル | 内容 | テスト |
|---|---|---|
| `src/config/file-storage-pricing.ts` | 単価/閾値/危険拡張子/sanitize/Object Key 生成 | 112 PASS |
| `src/config/billing-feature-units.ts` | `storage-file-overage` を BILLABLE 追加 + `attachment-embedding` を FREE 明示 | 13 PASS |
| `src/services/file-text-extraction.service.ts` | PDF/Excel/CSV/text/docx 本文抽出 (dynamic import + parser モック対応) | 20 PASS |
| `src/services/attachment-embedding.service.ts` | Voyage embed + ApiCallLog INSERT + 並行制御 (per-tenant 5 / global 50) | 4 PASS |
| `src/lib/stripe.ts` | `STRIPE_METER_EVENT_NAMES.storage_file_overage` 追加 | 既存 41 PASS |

### Prisma
| ファイル | 内容 |
|---|---|
| `prisma/schema.prisma` | Tenant 7 列 + Attachment 9 列追加 (vector(1024) embedding + status/retry/hash) |
| `prisma/migrations/20260526_file_storage_billing_and_embedding/migration.sql` | カラム追加 + URL backfill + index + rollback SQL |

### ドキュメント
| ファイル | 内容 |
|---|---|
| `docs/operations/SUPABASE_STORAGE_SETUP.md` | Bucket 作成手順 + RLS Policy SQL + CORS |
| `docs/operations/ENV_VARS.md` | `STRIPE_PRICE_STORAGE_FILE_OVERAGE` / `SUPABASE_STORAGE_BUCKET` / `SUPABASE_SERVICE_ROLE_KEY` 追加 |
| `docs/public/api-usage-guide.md` | attachment-embedding を「無料 API」分類に追加 + summary 更新 |

### 既存テストへの追加修正 (regression 防止)
| ファイル | 修正内容 |
|---|---|
| `src/config/billing-feature-units.test.ts` | 5 件期待値に更新 (storage-file-overage 追加) |
| `src/services/fair-use-limit.service.test.ts` | notIn 配列に storage-file-overage 追加 |
| `src/services/__tests__/tenant-isolation-invariants.test.ts` | 許可リストに file-text-extraction / attachment-embedding 追加 |

### package.json
- 依存追加 (要 `pnpm install`): `pdf-parse@^1.1.1` / `mammoth@^1.8.0` / `xlsx@0.20.3` (sheetjs tarball) / `@types/pdf-parse@^1.1.4`

---

## 残作業 (次セッション)

### PR-B (推奨): Service + Cron + Stripe 連携
| ID | タスク | 概要 |
|---|---|---|
| P3-upload-api | `POST /api/attachments/upload` + `/finalize` | Pre-signed URL 発行 (Supabase Storage SDK) / 50MB 検証 / 危険拡張子拒否 / tenant cap / rate limit (10/min) |
| P3-embedding-cron | embedding pending 背景処理 cron | `embeddingStatus='pending'` を fetch → extract → embed、指数 backoff (1/5/30min)、3 回失敗で `failed` |
| P3-storage-guard | `storage-guard.service.ts` 拡張 | `assertFileStorageLimitInTx` を追加し L3 ハードキャップ (50GB) で write 拒否 |
| P3-bucket-calc | `file-storage-bucket-usage.service.ts` | Supabase `storage.objects` 集計 → Tenant.storageFileBytesUsed 更新 |
| P3-attachment-service | 既存 service 拡張 | cascade delete (Supabase Storage 同時削除) / rate limit (100/min delete) |
| P3-chat-search | `chat-semantic-search.service` 拡張 | `detectFileScopeQuery()` で `attachmentEmbedding` のみスコープに |
| P3-suggestion-engine | `suggestion.service` 拡張 | attachment embedding を提案候補ソースに追加 |
| P3-anomaly | anomaly detection | per-tenant 5GB+/day で super_admin alert |
| P4-monthly-cron | `tenant-monthly-reset.service.ts` 拡張 | `processTenantFileStorageOverage()` を月初に呼出 |
| P4-daily-cron | `daily-notifications` 拡張 | bucket 集計 + drift + anomaly |
| P5-withdrawal | `tenant-withdrawal-billing.service.ts` 拡張 | 月途中解約時の file storage 精算 |
| P6-stripe-callType | `stripe-usage-flush.service.ts` 拡張 | `storage_file_overage` callType を flush 対象に |
| P6-env-stripe-setup | `STRIPE_SETUP.md` / `STRIPE_USAGE_FLUSH.md` 更新 | Price 作成手順追記 |
| P11-quality | lint/tsc/test/e2e:coverage/build フル PASS | |
| P12-commit-pr | commit + PR 作成 | |

### PR-C (別セッション推奨): UI + 残 docs
- P7-ui (7 件): tenant FileStorageSection / history / admin alerts / all-tenants + CSV / billing-summary / upload / chat
- P8-residual (7 件): plan-guide / about / TENANT_AND_BILLING / API_DESIGN / API call log / DATA_MODEL / SECURITY
- P9: integration test + 単体テスト網羅確認
- P13: full-scan 検証 4-6 round + KDD 記録
- P14: ユーザ作業案内 (Bucket 作成 + RLS 適用 + Stripe Meter 作成 + env 設定)

---

## 重要な注意点 (次セッションへ)

### 1. ブランチ状況
- ブランチ `feat/file-storage-usage-based-billing` は **未 commit**
- `git status --short` で全変更ファイルが見える

**本セッションで作成/変更したファイル (PR-A 候補)**:
- (新規) `src/config/file-storage-pricing.ts` + test
- (新規) `src/services/file-text-extraction.service.ts` + test
- (新規) `src/services/attachment-embedding.service.ts` + test
- (新規) `docs/operations/SUPABASE_STORAGE_SETUP.md`
- (新規) `prisma/migrations/20260526_file_storage_billing_and_embedding/`
- (新規) `HANDOFF_ADR_0021.md`
- (変更) `prisma/schema.prisma`
- (変更) `package.json` (4 deps 追加)
- (変更) `src/config/billing-feature-units.ts` + test
- (変更) `src/lib/stripe.ts`
- (変更) `src/services/fair-use-limit.service.test.ts` (regression fix)
- (変更) `src/services/__tests__/tenant-isolation-invariants.test.ts` (許可リスト追加)
- (変更) `docs/operations/ENV_VARS.md`
- (変更) `docs/public/api-usage-guide.md`

**本セッション「以前から」branch にあった変更ファイル (内容未確認、commit 含めるか別途判断)**:
- `docs/operations/README.md`
- `docs/public/README.md` / `docs/public/about.md`
- `prisma/seed-suggestion.ts`
- `src/app/(auth)/layout.tsx` / `src/app/(dashboard)/layout.tsx` / `src/app/(public)/layout.tsx` / `src/app/layout.tsx`
- `src/app/(dashboard)/projects/[projectId]/gantt/*` (2 files)
- `src/components/app-footer.tsx` / `src/components/app-header.tsx` + test
- `src/i18n/messages/{en-US,ja}.json`
- `src/lib/page-auth.ts` + test
- (未追跡) `docs/adr/0021-file-storage-usage-based-billing.md` (本セッション前に作成済)
- (未追跡) `docs/business/FILE_STORAGE_BILLING.md` (本セッション前に作成済)
- (未追跡) `docs/operations/MAINTENANCE_OPERATIONS.md` (本セッション前に作成済)
- (未追跡) `docs/public/file-storage-billing-guide.md` (本セッション前に作成済)

→ 次セッション開始時、これら pre-existing 変更が ADR-0021 と関係あるか確認し、関係なければ別ブランチへ切り出すこと。`git diff <file>` で内容確認推奨。

### 2. Migration 未適用
- `prisma/migrations/20260526_file_storage_billing_and_embedding/migration.sql` はファイルとして作成済だが、**ローカル DB へ未 apply**
- 次セッションで `pnpm prisma migrate dev` を実行する必要あり (もし P3 で実 DB 操作するなら)
- Prisma client は `pnpm prisma generate` 実行済 (型は最新)

### 3. パッケージ未 install
- package.json 依存追加済だが `pnpm install` 未実行
- 次セッション開始時、最初に `pnpm install` 必須
- ただし pdf-parse は import 時に default test file を探す既知の挙動あり (= dynamic import で回避済)、もし問題発生したら `pdf-parse-fork` か `pdf2json` への切替を検討

### 4. Stripe Price ID
- `STRIPE_PRICE_STORAGE_FILE_OVERAGE` env は **未設定** (Stripe Dashboard で Price ID 作成 + 環境変数セットがユーザ作業として残る、P14)

### 5. RLS Policy
- `docs/operations/SUPABASE_STORAGE_SETUP.md` に SQL は記載済だが、実際の Supabase project には **未適用** (P14 ユーザ作業)

### 6. テスト戦略の引き継ぎ
- `attachment-embedding.service.ts` は Prisma transaction + Voyage 呼出を含むため unit test は並行制御のみに留めた
- 本体動作は integration test (P9) で担保する設計
- 次セッションで P3-upload-api / P3-embedding-cron 実装後に integration test を書く

### 7. tenant-isolation 許可リスト
- `attachment-embedding.service.ts` を許可リストに追加済 (理由: id 主キー lookup + 呼出元で tenant 認可)
- 次セッションで新たに P3 で service 追加する時は、同様にコメント付きで許可リスト追加 or tenant フィルタ追加すること

---

## 関連リソース

- ADR: `docs/adr/0021-file-storage-usage-based-billing.md`
- 仕様: `docs/business/FILE_STORAGE_BILLING.md`
- ユーザ向け: `docs/public/file-storage-billing-guide.md`
- Memory: `project_adr_0021_in_progress` / `feedback_realistic_1pr_scope`
