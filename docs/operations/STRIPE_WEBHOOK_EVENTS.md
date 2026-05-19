# Stripe Webhook イベント リファレンス

最終更新: 2026-05-19
関連: [STRIPE_BILLING.md](../business/STRIPE_BILLING.md) / [STRIPE_SETUP.md](./STRIPE_SETUP.md)

本ドキュメントは、たすきばが Stripe から受信する **11 個の Webhook イベント** について「**いつ発生するか**」「**たすきばで何をするか**」「**ビジネス影響**」を整理したリファレンスです。

---

## §1. 全体構成

### 購読イベント一覧 (= Stripe Dashboard で設定する 11 件)

| # | カテゴリ | イベント名 | 重要度 | 処理ハンドラ |
|---|---|---|---|---|
| 1 | Customer | `customer.updated` | 低 | log のみ (副作用なし) |
| 2 | Subscription | `customer.subscription.created` | 中 | `handleSubscriptionUpdated` |
| 3 | Subscription | `customer.subscription.updated` | ⭐ 高 | `handleSubscriptionUpdated` |
| 4 | Subscription | `customer.subscription.deleted` | 中 | `handleSubscriptionDeleted` |
| 5 | Invoice | `invoice.created` | 中 | `handleInvoiceCreatedOrFinalized` |
| 6 | Invoice | `invoice.finalized` | 中 | `handleInvoiceCreatedOrFinalized` |
| 7 | Invoice | `invoice.paid` | ⭐ 高 | `handleInvoicePaid` |
| 8 | Invoice | `invoice.payment_failed` | ⭐ 高 | `handleInvoicePaymentFailed` |
| 9 | PaymentMethod | `payment_method.attached` | 中 | `handlePaymentMethodAttached` |
| 10 | PaymentMethod | `payment_method.detached` | 中 | `handlePaymentMethodDetached` |
| 11 | PaymentMethod | `payment_method.updated` | 中 | `handlePaymentMethodUpdated` |

すべてのハンドラ実装: [src/services/stripe-webhook-handlers.service.ts](../../src/services/stripe-webhook-handlers.service.ts)

---

## §2. Customer 関連 (4 件)

### 2.1 `customer.updated`

| 項目 | 内容 |
|---|---|
| **発火条件** | 顧客情報 (= 名前 / email / デフォルトカード等) が変更されたとき |
| **たすきば処理** | **ログのみ (副作用なし)**。将来の同期用に受信枠を確保 |
| **ビジネス影響** | なし。`StripeWebhookEvent` テーブルに受信履歴のみ残る |
| **冪等性** | 自明 (= 副作用ゼロ) |

### 2.2 `customer.subscription.created`

| 項目 | 内容 |
|---|---|
| **発火条件** | 顧客が `credit_card` 払いに切替えて **Subscription が新規作成された** 直後 |
| **たすきば処理** | `tenant.stripeSubscriptionId / Status / SubscriptionItemHaikuId / SonnetId / StorageId` を DB に同期 |
| **ビジネス影響** | DB の Stripe 関連情報を整合性確保 (= `setup/complete` ハンドラの DB-first パターンと相補) |
| **冪等性** | 同じ subscription を 2 回受信しても tenant.update は同値で上書き |

### 2.3 `customer.subscription.updated` ⭐ **最重要**

| 項目 | 内容 |
|---|---|
| **発火条件** | Subscription の状態変化 (= active → past_due / past_due → active / プラン変更等) |
| **たすきば処理** | ステータスを `tenant.stripeSubscriptionStatus` に同期。条件分岐:<br>**status='past_due'** → `autoSuspendScheduledAt = now + 3 日` をセット<br>**status='active'** に復帰 + `payment_delinquent` で suspend 中 → `resumeTenant()` 自動呼出 |
| **ビジネス影響** | **テナント停止 / 復帰の自動化の中核**。決済滞納による段階的サービス停止 / 入金確認後の即時復帰 |
| **冪等性** | 状態の update は同値で上書き、resume は `safeResumeTenant` で例外握り潰し |

### 2.4 `customer.subscription.deleted`

| 項目 | 内容 |
|---|---|
| **発火条件** | Subscription がキャンセルされた (= テナント解約 / Customer Portal キャンセル / Stripe API cancel) |
| **たすきば処理** | `tenant.stripeSubscriptionStatus = 'canceled'` 更新 + `autoSuspendScheduledAt` クリア |
| **ビジネス影響** | 解約済テナントの状態同期。これ以降の課金は停止 |
| **冪等性** | 同値の上書きで安全 |

---

## §3. Invoice 関連 (4 件)

### 3.1 `invoice.created`

| 項目 | 内容 |
|---|---|
| **発火条件** | Stripe が新規 Invoice を作成 (= 月末に自動 or 手動 invoicing) |
| **たすきば処理** | `BillingHistory` に **`status='pending'` で upsert** + 金額 (税抜 / 税 / 税込) 記録 |
| **ビジネス影響** | super_admin 請求ダッシュボード ([/admin/super/billing](../../src/app/(dashboard)/admin/super/billing/page.tsx)) で「入金待ち」として表示 |
| **冪等性** | (tenantId, yearMonth) UNIQUE key で upsert、status は既存値維持 (= 'paid' を 'pending' に戻さない) |

### 3.2 `invoice.finalized`

| 項目 | 内容 |
|---|---|
| **発火条件** | Invoice が確定され immutable (変更不可) になった |
| **たすきば処理** | 同上 `handleInvoiceCreatedOrFinalized`。金額が finalized 時点の最終値で上書き |
| **ビジネス影響** | 請求金額の確定。確定後の金額が顧客への請求の根拠 |
| **冪等性** | 同上 (upsert) |

### 3.3 `invoice.paid` ⭐ **重要**

| 項目 | 内容 |
|---|---|
| **発火条件** | Invoice が支払い済になった (= カード引落成功 / 手動消込) |
| **たすきば処理** | `BillingHistory.status = 'paid'` + `paidAt = now` 更新。**`payment_delinquent` で suspend 中なら `resumeTenant()` 自動呼出** |
| **ビジネス影響** | 入金確認の即時可視化 + 滞納テナントの即時復帰 (= 顧客体験の向上) |
| **冪等性** | upsert + resume は `safeResumeTenant` で安全 (= 既 resume 済は無視) |

### 3.4 `invoice.payment_failed` ⭐ **重要**

| 項目 | 内容 |
|---|---|
| **発火条件** | Invoice の支払いに失敗 (= カード引落失敗、`card_declined` / `insufficient_funds` 等) |
| **たすきば処理** | `BillingHistory.status = 'failed'`、`failureReason` 記録、`retryCount` increment |
| **ビジネス影響** | super_admin が [/admin/super/billing/{ym}?status=failed](../../src/app/(dashboard)/admin/super/billing/[yearMonth]/page.tsx) で即把握、督促対応 |
| **冪等性** | upsert + increment (= 2 回受信で retryCount が +2 されるが、`subscription.updated past_due` の方が確定的) |

---

## §4. PaymentMethod 関連 (3 件)

### 4.1 `payment_method.attached`

| 項目 | 内容 |
|---|---|
| **発火条件** | 新規カードが Customer に紐付けられた (= Checkout 完了 / Customer Portal でカード追加) |
| **たすきば処理** | `tenant.stripeDefaultPaymentMethodId` を新カード ID で更新 |
| **ビジネス影響** | カード登録の即時 DB 反映 → 次回課金時に新カードで引落 |
| **冪等性** | 同値の上書きで安全 |

### 4.2 `payment_method.detached`

| 項目 | 内容 |
|---|---|
| **発火条件** | カードが Customer から外された (= Customer Portal「Remove」/ API 経由削除) |
| **たすきば処理** | 該当が default だった場合のみ:<br>`stripeDefaultPaymentMethodId = null` + `cardVerificationStatus = 'never_verified'` |
| **ビジネス影響** | 「カード未登録」状態へ自動遷移 → 次回課金時に引落失敗 → `payment_failed` 経路へ |
| **冪等性** | default 以外の pm は無視 (= `payment_method_detached_non_default` action) |

### 4.3 `payment_method.updated`

| 項目 | 内容 |
|---|---|
| **発火条件** | カード情報が更新された (= 期限延長 / 再発行で番号変更等) |
| **たすきば処理** | default カードなら `cardVerificationStatus = 'never_verified'` + `cardLastVerifiedAt = null`。次回プラン変更時 / 月初検証 cron で `$0 SetupIntent` で再検証 |
| **ビジネス影響** | カード更新後の自動検証ループへ復帰 (= 不正カード混入を再チェック) |
| **冪等性** | default 以外の pm は無視 |

---

## §5. ライフサイクル全体図

```
[顧客がカード登録]
   ↓
✉️ payment_method.attached       → DB に default カード保存 (§4.1)
✉️ customer.subscription.created → Subscription / Item ID 同期 (§2.2)
   ↓
[毎月末 自動課金]
   ↓
✉️ invoice.created               → BillingHistory に pending 行追加 (§3.1)
✉️ invoice.finalized             → 金額確定 (§3.2)
   ↓
   ┌── 成功 ──────────────────────────────────────────┐
   │ ✉️ invoice.paid                                  │
   │    → BillingHistory.status='paid' (§3.3)         │
   │    → suspend 中なら自動復帰                       │
   └───────────────────────────────────────────────────┘
   ┌── 失敗 ──────────────────────────────────────────┐
   │ ✉️ invoice.payment_failed                        │
   │    → BillingHistory.status='failed' (§3.4)       │
   │    → Smart Retries (Stripe 自動 retry 3 回)      │
   │    ↓ retry 全失敗                                 │
   │ ✉️ customer.subscription.updated (past_due)      │
   │    → autoSuspendScheduledAt = +3 日 (§2.3)       │
   │    ↓ 3 日経過後                                   │
   │    → 日次 cron `stripe-auto-suspend` で suspend  │
   │      (= read-only モード)                         │
   │    ↓ 顧客がカード更新                              │
   │ ✉️ payment_method.updated (§4.3)                 │
   │    → cardVerificationStatus reset                │
   │    ↓ 再課金成功                                   │
   │ ✉️ invoice.paid (§3.3) → 自動復帰                │
   └───────────────────────────────────────────────────┘
   ↓
[テナント解約]
   ↓
   - 当社側 deleteTenant() で Stripe Subscription.cancel() を呼出 (= PR-V7 #1)
   ↓
✉️ payment_method.detached (§4.2)        → default カードクリア
✉️ customer.subscription.deleted (§2.4)  → status='canceled'
```

---

## §6. 冪等性保証の設計

### 6.1 受信側 (= Stripe → たすきば)

| 仕組み | 場所 | 役割 |
|---|---|---|
| `StripeWebhookEvent.id` UNIQUE PK | [schema.prisma](../../prisma/schema.prisma) | 同一 event.id の 2 回目受信は **`already_processed` で 200 即返却** |
| signature 検証 | [route.ts](../../src/app/api/webhooks/stripe/route.ts) | 改ざん / なりすまし防止 |
| トランザクション内処理 | 各 handler | DB 操作中の中断で部分反映を防ぐ |
| 失敗時 5xx 返却 | route.ts | Stripe が **3 日間自動再送** する仕様を活用 |

### 6.2 ハンドラ内ロジック

各ハンドラは **同一 event を複数回処理しても DB 状態が同じになる** よう設計:
- `tenant.update` は同値の上書き → 冪等
- `BillingHistory.upsert` は `tenantId_yearMonth` で UNIQUE → 同レコードの上書き
- `safeResumeTenant` は既 resume 済を例外で握り潰し → 冪等
- `resolveTenantBy*` は `deletedAt: null` フィルタで論理削除済テナントを無視 (PR-V7 #4)

### 6.3 DLQ (Dead Letter Queue)

| 失敗種別 | 場所 | リカバリ |
|---|---|---|
| Webhook 受信失敗 (retryCount >= 4) | `StripeWebhookEvent` table | [/admin/super/stripe-dlq](../../src/app/(dashboard)/admin/super/stripe-dlq/page.tsx) で手動再投入 |
| Usage Record 送信失敗 (DLQ) | `StripeUsageRecordQueue` table | 同上画面で手動再投入 |
| DB-Stripe 状態乖離 | 自動補正 | 月次 cron `/api/cron/stripe-reconcile` (PR-V7 #5) |

---

## §7. ハンドラ実装の参照

すべての handler 実装は [src/services/stripe-webhook-handlers.service.ts](../../src/services/stripe-webhook-handlers.service.ts) に集約。

| イベント | ハンドラ関数 | テスト |
|---|---|---|
| customer.updated | (dispatch で ignored 扱い) | — |
| customer.subscription.* | `handleSubscriptionUpdated` / `handleSubscriptionDeleted` | [stripe-webhook-handlers.service.test.ts](../../src/services/stripe-webhook-handlers.service.test.ts) |
| invoice.created/finalized | `handleInvoiceCreatedOrFinalized` | 同上 |
| invoice.paid | `handleInvoicePaid` | 同上 |
| invoice.payment_failed | `handleInvoicePaymentFailed` | 同上 |
| payment_method.* | `handlePaymentMethodAttached` / `Detached` / `Updated` | 同上 |

---

## §8. 関連ドキュメント

- 仕様: [STRIPE_BILLING.md](../business/STRIPE_BILLING.md) §3.2 (Webhook 設定) / §4 (フロー)
- セットアップ: [STRIPE_SETUP.md](./STRIPE_SETUP.md) §4 (Webhook エンドポイント)
- スキーマ: [prisma/schema.prisma](../../prisma/schema.prisma) `StripeWebhookEvent` / `BillingHistory`
- ライフサイクル: [STRIPE_BILLING.md](../business/STRIPE_BILLING.md) §4 (フロー詳細)

---

## §9. 改訂履歴

| 日付 | 変更 | PR |
|---|---|---|
| 2026-05-19 | 初版作成 (= 11 イベントの役割解説 + ライフサイクル図 + 冪等性設計) | docs/stripe-webhook-events-reference |
