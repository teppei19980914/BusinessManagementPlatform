# Stripe Metered Billing 連携 実装ロードマップ

最終更新: 2026-05-14
関連:
- 仕様: [STRIPE_BILLING.md](../business/STRIPE_BILLING.md)
- **詳細技術設計**: [STRIPE_TECHNICAL_DESIGN.md](../design/STRIPE_TECHNICAL_DESIGN.md) (= 各 PR の実装時に参照、judgment 不要レベルまで詰めた設計)
- 設計判断: [ADR-0006](../adr/0006-stripe-metered-billing-integration.md)

本ドキュメントは、Stripe Metered Billing 連携 (= v1.x 主要機能) の **PR 単位の実装フェーズ分割と依存関係** を定義する。

## 設計方針

「一気に実装」(= 単一の巨大 PR) ではなく **5 つの独立した PR** に分割する理由:
- 各 PR で独立した単体テスト + ローカル動作確認が可能
- レビュー単位を小さく保つ (= 1 PR あたり 500-800 行を目標)
- 万一の問題発生時にロールバック範囲を限定
- Stripe Test Mode での結合テストを各段階で実施可能
- 既存 PR (#371 月次請求, #372 read-only suspend) との整合性を段階的に確認

---

## §1. PR 全体像と依存関係

```
[main]
   │
   ├──> PR-S1: スキーマ + マイグレーション
   │       (Tenant カラム追加、StripeWebhookEvent、BillingHistory)
   │
   ├──> PR-S2: Stripe Service + 環境変数 (依存: PR-S1)
   │       (stripe-billing.service.ts、env vars、ヘルパ群)
   │
   ├──> PR-S3: API endpoints (依存: PR-S2)
   │       (/setup, /portal, /verify, PATCH /billing)
   │
   ├──> PR-S4: Webhook ハンドラ (依存: PR-S1, PR-S2)
   │       (/api/webhooks/stripe + 全イベント処理 + 冪等性)
   │
   ├──> PR-S5: UI 拡張 (依存: PR-S3)
   │       (/settings/tenant の支払い方法セクション)
   │
   └──> PR-S6: 連携 + 自動 suspend (依存: PR-S2, PR-S4)
           (withMeteredLLM への Usage Record 送信、自動 suspend cron、月次照合 cron)
```

**注**: PR-S3 と PR-S4 は並列で進められる (= 互いに依存しない)。PR-S5 は PR-S3 のあと、PR-S6 は PR-S4 のあと。

---

## §2. PR-S1: スキーマ + マイグレーション

### スコープ
- `prisma/schema.prisma`: Tenant に新規 7 カラム追加 (`stripeCustomerId` 等)
- `prisma/schema.prisma`: `StripeWebhookEvent` モデル新規追加
- `prisma/schema.prisma`: `BillingHistory` モデル新規追加
- `prisma/migrations/2026XXXX_stripe_integration/migration.sql` 作成 + 部分インデックス

### 含まれるテスト
- スキーマ generate 成功確認
- `pnpm prisma migrate dev` でローカル DB に適用成功確認

### 含まれないもの
- サービス層 / API / UI (= PR-S2 以降)

### 依存
- なし (= main から切る)

### 工数目安
- 0.5 日

### ロールバック手順
- `ALTER TABLE tenants DROP COLUMN stripe_customer_id, ...` + `DROP TABLE stripe_webhook_events, billing_history` で完全ロールバック可能 (NULLABLE 追加のみのため安全)

---

## §3. PR-S2: Stripe Service + 環境変数

### スコープ
- `src/services/stripe-billing.service.ts` (新規) を作成
  - `createOrGetStripeCustomer(tenantId): Stripe.Customer`
  - `createCheckoutSessionForCardSetup(tenantId, returnUrl): Stripe.Checkout.Session`
  - `createCustomerPortalSession(tenantId, returnUrl): Stripe.BillingPortal.Session`
  - `verifyTenantCard(tenantId): { ok: boolean, status: 'valid'/'expired'/'declined', failureReason?: string }`
  - `createSubscriptionForTenant(tenantId, plan): Stripe.Subscription`
  - `reportUsage(tenantId, callType: 'haiku'/'sonnet', quantity: number)`: SubscriptionItem に Usage Record 送信
- `src/lib/stripe.ts` (新規) を作成
  - Stripe SDK 初期化 (`new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2024-12-18.acacia' })`)
  - 環境変数ヘルパ
- `package.json`: `stripe` パッケージ追加 (v17.0+)
- `.env.example` / `docs/operations/ENV_VARS.md` 更新: 全 Stripe 環境変数を追記

### 含まれるテスト
- `stripe-billing.service.test.ts`: 各関数の単体テスト (Stripe SDK モック使用)
  - 正常系 / Stripe API エラー時の挙動 / 既存 Customer 流用 (= 同一テナントへ 2 回 createOrGet すると同じ Customer ID を返す) 等
- カバレッジ: 80% 以上を目標

### 含まれないもの
- API route (= PR-S3)
- Webhook ハンドラ (= PR-S4)
- 実 Stripe との結合テスト (= ローカル `pnpm test` ではモック、ローカル手動で Test Mode 実通信)

### 依存
- PR-S1 (= スキーマカラムを使用)

### 工数目安
- 1.5 日

---

## §4. PR-S3: API endpoints

### スコープ
- 新規 route 作成 (= 4 つ):
  - `src/app/api/tenants/me/billing/stripe/setup/route.ts` (POST)
  - `src/app/api/tenants/me/billing/stripe/portal/route.ts` (POST)
  - `src/app/api/tenants/me/billing/stripe/verify/route.ts` (POST)
  - `src/app/api/tenants/me/billing/route.ts` (PATCH)
- 既存 `src/services/tenant-self.service.ts` の `updateTenantPlan` にプラン変更時のカード検証フローを追加
  - `paymentMethod === 'credit_card'` のときのみ `verifyTenantCard()` を実行 → 失敗時 `CARD_VERIFICATION_FAILED` で 400 拒否

### 含まれるテスト
- 各 route の `route.test.ts`: 認可 (admin / general / unauth) / バリデーション / サービス層エラー変換
- `tenant-self.service.test.ts`: プラン変更時のカード検証分岐 (新規ケース追加)

### 含まれないもの
- UI 実装 (= PR-S5)
- Webhook (= PR-S4)

### 依存
- PR-S2 (= Stripe Service を使用)

### 工数目安
- 1.5 日

### E2E カバレッジ更新
- `docs/test/E2E_COVERAGE.md` に新規 route 4 つを追記 (`[ ] skip: Stripe Test Mode 統合は v2 で検討`)

---

## §5. PR-S4: Webhook ハンドラ

### スコープ
- 新規 route: `src/app/api/webhooks/stripe/route.ts` (POST)
  - シグネチャ検証 (`stripe.webhooks.constructEvent()`)
  - StripeWebhookEvent テーブルに INSERT (event.id で冪等性保証)
  - イベント type ごとのハンドラ dispatch
- イベントハンドラ実装:
  - `customer.subscription.created` / `updated` / `deleted`
  - `invoice.created` / `finalized` / `paid` / `payment_failed`
  - `payment_method.attached` / `detached` / `updated`
  - `customer.updated`
- 各ハンドラは `src/services/stripe-webhook-handlers.service.ts` (新規) に集約

### 含まれるテスト
- `stripe-webhook-handlers.service.test.ts`: 各イベント type ごとに正常系 / 失敗系
- 冪等性テスト: 同じ event.id を 2 回 INSERT → 2 回目はスキップ
- シグネチャ検証失敗テスト: 不正な signature で 400 返却

### 含まれないもの
- UI 表示への反映 (= 別 PR で連動)
- 自動 suspend cron (= PR-S6)

### 依存
- PR-S1, PR-S2

### 工数目安
- 2 日

### セキュリティ
- 公開エンドポイント (= 認証不要) のため、**Stripe signature 検証が唯一の認可** ← 重点的にレビュー
- middleware の `PUBLIC_PATHS` に `/api/webhooks/stripe` を追加

---

## §6. PR-S5: UI 拡張

### スコープ
- `src/app/(dashboard)/settings/tenant/tenant-settings-client.tsx` 更新:
  - 「支払い方法」セクション新設 (= 状態 A/B/C/D の出し分け)
  - 「💳 クレジットカード払いに切替」「🔧 Stripe ポータルで管理」ボタン
  - プラン変更ダイアログにカード検証ステップ追加
- `src/components/settings/PaymentMethodSection.tsx` (新規) を抽出 (= テスト容易性)

### 含まれるテスト
- React component テスト (RTL): 各状態 A/B/C/D の表示確認
- ボタン click → 正しい API 呼出を確認 (= fetch モック)

### 含まれないもの
- 実 Stripe Checkout 経由の E2E (= v2)

### 依存
- PR-S3 (= API endpoint を呼ぶ)

### 工数目安
- 1.5 日

---

## §7. PR-S6: 連携 + 自動 suspend

### スコープ
- `src/lib/llm/metered.ts` (`withMeteredLLM`) 更新:
  - 既存処理に加え、`paymentMethod === 'credit_card'` のテナントなら `stripe-billing.service.ts` の `reportUsage()` を呼出
  - 失敗時は同期的に throw せず非同期 queue (`stripe_usage_record_queue` テーブル 新規 or 既存 queue 流用) に積む
  - 5 分間隔の cron で再送 (= 簡易実装、idempotency_key で重複防止)
- `src/services/super-admin.service.ts` (`suspendTenant` の前後で連動):
  - `customer.subscription.updated` (status='past_due') Webhook 受信時 → `tenant.autoSuspendScheduledAt = now + 3 日` をセット
  - 日次 cron で `autoSuspendScheduledAt <= now` のテナントを `suspendTenant('payment_delinquent', SYSTEM_USER_ID)` で自動停止
  - `invoice.paid` Webhook 受信時 → 停止中なら `resumeTenant()` で自動解除
- `src/app/api/cron/tenant-monthly-reset/route.ts` 更新:
  - 月初リセット時に、credit_card テナントの `tenant.stripeSubscriptionStatus` を Stripe API で再取得して DB を同期 (= 突合チェック)

### 含まれるテスト
- `metered.service.test.ts`: Usage Record 送信成功 / 失敗時の queue 追加
- 自動 suspend cron テスト (新規)
- 月次照合テスト: DB と Stripe 状態の不一致を検出して自動修正

### 含まれないもの
- 何もなし (= 最終 PR、これでフィーチャー完成)

### 依存
- PR-S2, PR-S4

### 工数目安
- 2 日

### 重要なリスク
- `withMeteredLLM` への配線で **既存 LLM 呼び出しが止まる** リスクが最も高い
- Stripe API 障害時に同期的に throw すると顧客体験が壊れる → 非同期 queue で確実に分離する

---

## §8. 全 PR 共通の前提

### 環境変数準備 (実装開始前に super_admin が完了させる)
- [docs/operations/STRIPE_SETUP.md](../operations/STRIPE_SETUP.md) に従い Stripe Dashboard セットアップ
- 全 7 環境変数 (`STRIPE_SECRET_KEY` 等) を Vercel に登録 (Test / Production 両方)

### 各 PR 共通のチェックリスト
- [ ] `pnpm test` で全テスト PASS
- [ ] `pnpm lint` errors 0
- [ ] `pnpm tsc --noEmit` で型エラー 0
- [ ] `pnpm e2e:coverage-check` PASS (新規 route 追加した PR のみ)
- [ ] Vercel Preview Deploy で動作確認
- [ ] KDD ナレッジ追記 (落とし穴に遭遇したら)

---

## §9. 想定総工数

| PR | 工数 | 累積 |
|---|---|---|
| PR-S1: スキーマ | 0.5 日 | 0.5 日 |
| PR-S2: Service | 1.5 日 | 2 日 |
| PR-S3: API | 1.5 日 | 3.5 日 |
| PR-S4: Webhook | 2 日 | 5.5 日 |
| PR-S5: UI | 1.5 日 | 7 日 |
| PR-S6: 連携 | 2 日 | 9 日 |
| **合計** | **約 9 営業日** | (= 約 2 週間) |

並列化すれば 5-6 営業日に短縮可能 (= PR-S3 と PR-S4 を並列、PR-S5 と PR-S6 を並列)。

---

## §10. リリース判断のチェックポイント

各 PR マージ時点で以下を確認:

| チェック | PR-S1 | PR-S2 | PR-S3 | PR-S4 | PR-S5 | PR-S6 |
|---|---|---|---|---|---|---|
| 既存 invoice 運用に影響なし | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ withMeteredLLM 変更あり |
| Stripe Test Mode で動作確認 | - | ✅ | ✅ | ✅ | ✅ | ✅ |
| ロールバック可能 | ✅ schema drop | ✅ revert | ✅ revert | ✅ revert | ✅ revert | ⚠️ 既存 LLM 動作影響、要慎重 |
| 顧客向けリリース | ❌ 内部のみ | ❌ | ❌ | ❌ | 🟡 切替 UI 表示開始 (= feature flag で隠す) | ✅ 完全リリース |

最終 PR (PR-S6) マージ後に **feature flag を有効化** して顧客に公開する設計を推奨 (= 段階的ロールアウト)。

---

## §11. リリース後の追跡

- 初回引き落としテナントが発生したら、`billing_history` で `status='paid'` までの全 Webhook 受信を監査
- 月次集計が DB / Stripe 双方で一致しているか確認 (= PR-S6 の月次照合 cron で自動だが、初月は手動も)
- 異常 (= Webhook 未着、Usage Record 不一致) があれば KDD §5.X+59〜 に追記

---

## 改訂履歴

| 日付 | 変更 | PR |
|---|---|---|
| 2026-05-14 | 初版策定 (v1.x Stripe 連携計画) | docs/stripe-integration-spec |
