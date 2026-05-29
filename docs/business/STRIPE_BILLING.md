# Stripe Metered Billing 連携仕様 (v1.x)

最終更新: 2026-05-29 (ADR-0025 Beginner write block 反映)
ステータス: **仕様確定 + 実装済 (PR #425 で UAT 検出問題群を反映、PR #441 で ADR-0019 価格改定反映、ADR-0022 で Embedding 課金導入、ADR-0025 で Beginner write block 導入)**

> 🆕 **ADR-0025 (2026-05-29) Beginner write block 反映済**:
> - **Beginner プランへの Stripe queue 投入は 0 件**: DB 50MB / Storage 100MB 超過時は ApiCallLog `db-capacity-overage` / `storage-file-overage` の INSERT 自体を skip (audit_log で skip 証跡のみ記録、entityType=`api_call_log_skip`)
> - **Stripe 請求書に Beginner overage 行が現れない**: monthly cron / 退会精算の両経路で skip ロジック適用
> - **billing-invariant 維持**: ApiCallLog SUM = 表示 = 請求 の不変条件は崩れず、Beginner は SUM=0 で構造的に整合
> - 詳細: [ADR-0025](../adr/0025-beginner-write-guard.md)

> 🆕 **ADR-0022 (2026-06-01) Embedding 課金導入反映済**:
> - **Beginner プラン**: Embedding 系 (資産入力・チャット検索・CSV インポート・添付ファイル本文 embedding) は **¥0 維持** (= 「90 日完全無料」訴求保全)
> - **Expert / Pro プラン**: Embedding 系を **¥1 / 業務操作** で従量課金 (= 1 ApiCallLog = 1 課金、CSV 100 件取込でも ¥1 の集約設計)
> - **embedding-backfill** (月初 cron 自動リカバリ): 全プラン無料維持 (= ユーザ非起動の修復処理は不当請求リスク回避)
> - **Fair Use Limit** (月 10,000 calls/tenant): Beginner プラン専用に縮小 (Expert/Pro は `monthlyBudgetCap` で自然防御)
> - **新 Stripe Meter event 名**: `tasukiba_embedding_call`
> - **新 Price ID 環境変数**: `STRIPE_PRICE_EMBEDDING` (= optional、リリース時は未設定、将来 Stripe 有効化時に設定 = Stripe-ready 設計)
>
> 詳細: [ADR-0022](../adr/0022-embedding-usage-based-billing.md)
>
> **ADR-0019 (2026-05-24) 価格改定反映済** (ADR-0022 で部分 supersede): Expert ¥5 → ¥10 / Pro ¥15 据置 / 課金対象を `BILLABLE_FEATURE_UNITS` (= ADR-0022 で 4 階層化、`LLM_BILLABLE` + `EMBEDDING_BILLABLE` + `STORAGE_OVERAGE` の合算) に限定。詳細: [ADR-0019](../adr/0019-billable-feature-units-and-free-tier-expansion.md)
関連:
- 詳細技術設計: [docs/design/STRIPE_TECHNICAL_DESIGN.md](../design/STRIPE_TECHNICAL_DESIGN.md) (= 本仕様の「how」レベル詳細)
- 設計判断: [docs/adr/0006-stripe-metered-billing-integration.md](../adr/0006-stripe-metered-billing-integration.md)
- 実装計画: [docs/roadmap/STRIPE_INTEGRATION_PLAN.md](../roadmap/STRIPE_INTEGRATION_PLAN.md)

## 概要

本ドキュメントは、たすきば Knowledge Relay における **クレジットカード払い + Stripe Metered Billing による自動引き落とし** の仕様を定義する。v1 (2026-06-01) でリリース済の **手動運用 (`invoice` = 銀行振込)** と **並存** する形で v1.x にて実装する。

> 2026-05-15: 旧 `bank_transfer` 値は `invoice` に統合済 (UI ラベル「銀行振込」)。本ドキュメント内の旧 `bank_transfer` 言及は履歴として残置するが、新規実装では `invoice` のみを参照すること。詳細 [ADR-0007](../adr/0007-unify-invoice-and-bank-transfer.md)。

### スコープ

**含めるもの (MVP)**:
- クレジットカード登録 (Stripe Checkout)
- 支払い方法切替 (`invoice` ↔ `credit_card`)
- 月末確定 Metered Billing (リアルタイム Usage Record 送信 → 月末自動集計)
- Stripe Customer Portal 埋め込み (カード更新・履歴閲覧)
- Webhook 連携 (subscription / invoice / payment_method 系イベント)
- **プラン変更時のカード検証** ($0 SetupIntent による有効性確認)
- Smart Retries + 自動 suspend (引落失敗時、PR #372 の suspendTenant を Webhook 経由で自動呼出)
- Stripe Tax (インボイス制度対応、JCT 登録番号自動表記)

**除外するもの (v2 以降)**:
- 同一テナントへの複数カード登録
- 3D Secure 認証フローのカスタマイズ
- 個別顧客の拒否ルール (= サブスク作成時の手動承認)
- 複数通貨対応 (USD / EUR)

---

## §1. 用語定義

| 用語 | 定義 |
|---|---|
| **Stripe Customer** | Stripe 上のテナント表現。`Tenant.stripeCustomerId` に保存 |
| **Stripe Subscription** | Stripe 上のテナント契約。1 テナント = 1 Subscription |
| **Subscription Item** | Subscription 内の課金単位 (= 「Haiku per-call」「Sonnet per-call」「Storage 月額」をそれぞれ 1 Item) |
| **Usage Record** | Subscription Item に対する使用量レポート (= 各 API 呼び出しで送信) |
| **Payment Method** | Stripe Customer に紐付くカード情報 |
| **SetupIntent** | カード登録時のトークン化処理 (本仕様ではカード検証にも使用) |
| **Invoice (Stripe)** | Stripe が月末に自動生成する請求書 |
| **Smart Retries** | Stripe の自動再試行機能。引落失敗時に最大 4 回まで自動リトライ |

---

## §2. データモデル

### 2.1 `Tenant` モデル追加カラム

```prisma
model Tenant {
  // 既存 (PR #2 以降)
  paymentMethod  String  @default("invoice")  // 'invoice' (= 銀行振込) / 'credit_card'。2026-05-15 'bank_transfer' を 'invoice' に統合

  // 新規 (本仕様、v1.x PR #X)
  /// Stripe Customer ID。credit_card 払いに切替えた時点で作成。null = 未登録
  stripeCustomerId               String?   @unique @map("stripe_customer_id") @db.VarChar(50)
  /// Stripe Subscription ID。プラン契約時に作成、削除時に null へ
  stripeSubscriptionId           String?   @unique @map("stripe_subscription_id") @db.VarChar(50)
  /// Subscription の状態 ('active' / 'past_due' / 'canceled' / 'incomplete' 等)
  stripeSubscriptionStatus       String?   @map("stripe_subscription_status") @db.VarChar(30)
  /// Haiku (Expert) per-call Subscription Item ID。Metered Billing の Usage Record 送信先
  stripeSubscriptionItemHaikuId  String?   @map("stripe_subscription_item_haiku_id") @db.VarChar(50)
  /// Sonnet (Pro) per-call Subscription Item ID
  stripeSubscriptionItemSonnetId String?   @map("stripe_subscription_item_sonnet_id") @db.VarChar(50)
  // chore/storage-addon-backend-removal (2026-05-26):
  //   stripeSubscriptionItemStorageId は撤去 (ADR-0020/0021 で従量課金化、4 段階プラン廃止)
  /// Default Payment Method ID (= デフォルトの請求用カード)
  stripeDefaultPaymentMethodId   String?   @map("stripe_default_payment_method_id") @db.VarChar(50)

  /// 直近のカード検証成功時刻 (プラン変更時 / 月初に検証 cron が更新)
  cardLastVerifiedAt             DateTime? @map("card_last_verified_at") @db.Timestamptz
  /// カード検証状態: 'valid' / 'expired' / 'declined' / 'never_verified'
  cardVerificationStatus         String?   @map("card_verification_status") @db.VarChar(20)
  /// Smart Retries 全失敗後の自動 suspend 予定時刻 (= Webhook で payment_failed 受信時にセット)
  ///   既存 PR #372 の suspendTenant() がこれを参照して自動実行
  autoSuspendScheduledAt         DateTime? @map("auto_suspend_scheduled_at") @db.Timestamptz
}
```

### 2.2 `StripeWebhookEvent` テーブル (新規、冪等性確保用)

```prisma
/// Stripe Webhook の **冪等性保証** + **再送 / リプレイ対応** のための受信イベント記録
///   - Stripe は同じイベントを複数回送信する可能性がある (公式仕様)
///   - 受信時に id (= Stripe event.id) で UNIQUE INSERT、既存ならスキップ
///   - processedAt で「処理済」を判定、失敗時は再試行可能
model StripeWebhookEvent {
  id          String   @id @db.VarChar(50)  // = Stripe event.id (e.g. "evt_xxxxx")
  type        String   @db.VarChar(60)       // 'customer.subscription.updated' 等
  payloadJson Json     @map("payload_json")
  receivedAt  DateTime @default(now()) @map("received_at") @db.Timestamptz
  /// 処理完了時刻。null = 未処理 (受信のみ) / Date = 処理完了
  processedAt DateTime? @map("processed_at") @db.Timestamptz
  /// 処理失敗時のエラー (運用調査用)
  errorMessage String? @map("error_message") @db.Text

  @@index([type], map: "idx_stripe_webhook_events_type")
  @@index([processedAt], map: "idx_stripe_webhook_events_processed_at")
  @@map("stripe_webhook_events")
}
```

### 2.3 `BillingHistory` テーブル (新規、課金履歴の統一管理)

```prisma
/// 請求履歴。invoice (= 銀行振込) / credit_card の **全支払い方法を統一管理**。
///   - invoice (= 銀行振込): super_admin が手動で `paid` に更新
///   - credit_card: Stripe Webhook で自動更新
///   - 既存 tenant_monthly_usage_history (= 使用量スナップショット) との違い:
///     こちらは「請求書 / 決済」のライフサイクル管理、月次集計の確定値ではなく支払い状況の追跡
model BillingHistory {
  id              String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  tenantId        String   @map("tenant_id") @db.Uuid
  /// "YYYY-MM" 形式の請求対象月
  yearMonth       String   @map("year_month") @db.VarChar(7)
  /// 支払い方法 ('invoice' = 銀行振込 / 'credit_card')
  paymentMethod   String   @map("payment_method") @db.VarChar(20)
  /// 課金額 (税抜、円整数)
  amountJpy       Int      @map("amount_jpy")
  /// 消費税額 (円整数)。Stripe Tax 計算結果を保存
  taxAmountJpy    Int      @map("tax_amount_jpy")
  /// 税込み合計 (= amount_jpy + tax_amount_jpy)
  totalAmountJpy  Int      @map("total_amount_jpy")
  /// 状態 ('pending' / 'paid' / 'failed' / 'refunded' / 'canceled')
  status          String   @map("status") @db.VarChar(20)
  /// Stripe Invoice ID (credit_card 払いのみ)
  stripeInvoiceId String?  @map("stripe_invoice_id") @db.VarChar(50)
  /// 入金確認日時 (status='paid' 時)
  paidAt          DateTime? @map("paid_at") @db.Timestamptz
  /// 失敗理由 ('card_declined' / 'insufficient_funds' / 'expired_card' 等)。Stripe failure_code を保存
  failureReason   String?  @map("failure_reason") @db.VarChar(50)
  /// Smart Retries の試行回数 (credit_card のみ、0〜4)
  retryCount      Int      @default(0) @map("retry_count")
  createdAt       DateTime @default(now()) @map("created_at") @db.Timestamptz
  updatedAt       DateTime @updatedAt @map("updated_at") @db.Timestamptz

  tenant Tenant @relation(fields: [tenantId], references: [id])

  /// (tenantId, yearMonth) は 1 件のみ
  @@unique([tenantId, yearMonth], map: "uq_billing_history_tenant_month")
  @@index([status], map: "idx_billing_history_status")
  @@index([stripeInvoiceId], map: "idx_billing_history_stripe_invoice")
  @@map("billing_history")
}
```

---

## §3. Stripe 側の事前セットアップ (運用者が手動実施)

### 3.1 Stripe アカウント・Product・Price の作成

実装前に super_admin が Stripe Dashboard で以下を手動セットアップする (詳細手順は [docs/operations/STRIPE_SETUP.md](../operations/STRIPE_SETUP.md) 参照):

| Product 名 | Price ID 環境変数 | 課金タイプ | 単価 |
|---|---|---|---|
| Expert プロジェクト作成/更新 (Haiku) | `STRIPE_PRICE_HAIKU` | Metered (per_unit) | **¥10 / call** (ADR-0019 / 2026-05-24 改定: ¥5 → ¥10) |
| Pro プロジェクト作成/更新 + なぜ機能 (Sonnet) | `STRIPE_PRICE_SONNET` | Metered (per_unit) | **¥15 / call** (据置) |
| **Embedding 業務操作** (ADR-0022 / 2026-06-01) | `STRIPE_PRICE_EMBEDDING` *(optional)* | Metered (per_unit) | **¥1 / call** (Expert/Pro 共通、Beginner は Subscription 不要 / cost=0 のため queue 不投入) |
| Storage Add-on (Plus) | `STRIPE_PRICE_STORAGE_PLUS` | Recurring (固定) | ¥500 / 月 |
| Storage Add-on (Pro Storage) | `STRIPE_PRICE_STORAGE_PRO` | Recurring (固定) | ¥1,500 / 月 |

> **ADR-0022 (2026-06-01) Stripe-ready 設計**: `STRIPE_PRICE_EMBEDDING` 環境変数は **optional**。リリース時 (2026-06-01) は credit_card 払い未対応のため未設定で動作 (= `createSubscriptionForTenant` は Haiku + Sonnet の 2 本だけ Subscription Item を作成)。将来 Stripe Dashboard で新 Meter (`tasukiba_embedding_call`) + 新 Price (¥1/call) を作成し env を設定すると、`createSubscriptionForTenant` が 3 本目の Subscription Item として自動追加し、コード変更ゼロでクレジットカード払い経路が動き出します。

> **重要 (ADR-0019 / 2026-05-24 価格改定)**: Stripe では一度作成した Price の単価変更ができません。**新規 Price を作成して Subscription Item を切り替える運用** が必要です。手順:
> 1. Stripe Dashboard で新 Haiku Price (¥10/call) を作成 (Sonnet は ¥15 据置のため変更不要)
> 2. 環境変数 `STRIPE_PRICE_HAIKU` を新 Price ID に更新 (Netlify production / staging 両方)
> 3. 既存の credit_card テナントの Subscription Item を新 Price に migrate (super_admin が `stripe_billing.service` 経由で実施)
> 4. 旧 Price (¥5/call) は archive (削除不可、archive のみ)
>
> Sonnet Price (¥15/call) は据置のため、上記手順は Haiku のみ実施。
>
> 移行中は新旧 Price が並行して Usage Record を受け取り得るが、`Subscription Item` の active 状態管理で防御。詳細手順は [docs/operations/STRIPE_SETUP.md](../operations/STRIPE_SETUP.md) を参照。

### 3.2 Webhook エンドポイント設定

Stripe Dashboard → Developers → Webhooks → Add endpoint:

- URL: `https://<host>/api/webhooks/stripe`
- Signing secret: 環境変数 `STRIPE_WEBHOOK_SECRET` に保存
- 受信イベント (購読する種類):
  - `customer.subscription.created`
  - `customer.subscription.updated`
  - `customer.subscription.deleted`
  - `invoice.created`
  - `invoice.finalized`
  - `invoice.paid`
  - `invoice.payment_failed`
  - `payment_method.attached`
  - `payment_method.detached`
  - `payment_method.updated` (= カード期限変更等)
  - `customer.updated`

### 3.3 Stripe Tax 有効化

- Dashboard → Tax → Settings → "Enable Stripe Tax" を ON
- JCT 登録番号 (適格請求書発行事業者番号) を登録
- 商品 / Price ごとに Tax Code を設定 (SaaS なら `txcd_10000000` = digital services)

---

## §4. 主要フロー

### 4.1 クレジットカード払いへの切替フロー (1 ステップ強制遷移 / 2026-05-22 PR #425 確定版)

**設計方針** (KDD §5.X+103):
- 「請求先情報フォーム」で paymentMethod を `credit_card` に変更して保存した瞬間に、サーバ側が **自動で Stripe Checkout に強制遷移**
- カード登録 + Stripe での検証 + Subscription 作成 が成功した時のみ DB の `paymentMethod` が `credit_card` に確定する (= 失敗時は invoice のまま、中間状態を作らない)
- カード未登録で `paymentMethod='credit_card'` に書き換える経路は、service 層の `CreditCardNotRegisteredError` (422) で UI / API バイパス双方を構造的に拒絶
- Subscription 作成と同時に **Customer.invoice_settings.default_payment_method** も同期 (= 3 点完全一致: アプリ画面 = Customer Portal = 実引落カード) (KDD §5.X+108)

```
[テナント管理者] /settings/tenant の「請求先情報」セクションで
                 「支払い方法」を「クレジットカード」に変更 → 「請求先情報を更新」ボタン押下
   ↓
[クライアント (BillingContactSection.handleSubmit)]
   isInvoiceToCreditCardTransition === true を検知:
   1. paymentMethod を除外して住所等だけ PATCH /api/tenants/me/billing で更新
   2. POST /api/tenants/me/billing/stripe/setup で Stripe Checkout URL を取得
   3. window.location.href = checkoutUrl (= 強制遷移)
   ↓
[サーバ /setup]
   - tenant.stripeSubscriptionId が既に存在 → 409 ALREADY_HAS_SUBSCRIPTION (= Customer Portal で更新すべき)
     (旧ガード paymentMethod === 'credit_card' は新 2 ステップに対応するため判定軸を sub_id に変更、KDD §5.X+100)
   - tenant.stripeCustomerId が null なら stripe.customers.create() で Customer 作成
   - stripe.checkout.sessions.create() で SetupSession 生成 (mode='setup')
     * success_url = /api/tenants/me/billing/stripe/setup/complete?session_id={CHECKOUT_SESSION_ID}
     * cancel_url = /settings/tenant?stripe_setup=canceled
   ↓
[ブラウザ] Stripe Checkout 画面 — 顧客がカード番号を入力 (Stripe が PCI DSS 対応で受領)
   ↓
   ┌─────────────────────┬─────────────────────────────────┐
   │ 成功 (カード登録 OK)  │ 失敗 (キャンセル / カード拒否)   │
   └─────────────────────┴─────────────────────────────────┘
   │                       │
   ▼                       ▼
[Webhook] payment_method.attached を受信
   ↓
[ブラウザ] success_url に Stripe からリダイレクト
   ↓
[サーバ /setup/complete ハンドラ (= 6 ステップ)]
   Step 1: stripe.checkout.sessions.retrieve(session_id) で SetupSession 情報を取得
   Step 2: setup_intent.payment_method を取得 (= pm_xxx)
   Step 3: **検証**: stripe.setupIntents.confirm() で $0 verification 試行
      - 失敗 → /settings/tenant?stripe_setup=failed&reason=<failure_code> へリダイレクト
              tenant.paymentMethod は invoice のまま (= 状態不変)
   Step 3.5 (★PR #425 / KDD §5.X+107★): cancelAllActiveStripeSubscriptionsForCustomer
      - 同 Customer の active な Subscription を **全 cancel**
      - 目的: DB drift (= DB は sub_id=null だが Stripe に active 残置) の自動修復 + 二重 Subscription 防止
      - 失敗は console.warn のみで続行 (= 既 canceled / Webhook で最終整合)
   Step 4: createSubscriptionForTenant
      - stripe.subscriptions.create() で Subscription 作成
        * items: Haiku / Sonnet / Storage の Subscription Item を作成
        * default_payment_method = pm_xxx
        * automatic_tax: { enabled: true }
        * idempotencyKey = `subscription:create:${tenantId}:${paymentMethodId}` (★PR #425 / KDD §5.X+106★)
          - 旧 key (= tenantId のみ) では「テナント生涯 1 回」の制約になり、カード差替で
            「Keys for idempotent requests can only be reused with the same parameters」エラー
   Step 5: DB の最終 commit (= 'credit_card' 切替確定)
      - tenant.stripeSubscriptionId / SubscriptionItemHaikuId / ...Sonnet... / ...Storage...
      - tenant.stripeDefaultPaymentMethodId = pm_xxx
      - tenant.paymentMethod = 'credit_card'
      - tenant.cardLastVerifiedAt = now
      - tenant.cardVerificationStatus = 'valid'
      - tenant.stripeSubscriptionStatus = 'active'
   Step 6 (★PR #425 / KDD §5.X+108★): stripe.customers.update で
      Customer.invoice_settings.default_payment_method = pm_xxx を同期
      - 目的: アプリ画面 / Customer Portal / 実引落カード の 3 点完全一致
      - 失敗は console.warn のみで続行 (= Subscription は既に成功、Customer デフォルトは「ズレる」だけで課金事故にはならない)
   → /settings/tenant?stripe_setup=success へリダイレクト
   ↓                       ↓
[完了] 次回 API 呼出から   [ブラウザ] cancel_url または failed パラメタで着地
Usage Record を Stripe へ送信   - paymentMethod は invoice のまま (= 設定前の状態を維持)
                            - トースト表示: 「クレジットカード登録をキャンセルしました」
                              または「カード登録に失敗しました (理由: <message>)」
```

> 旧仕様 (= 「支払い方法」セクション内の独立ボタン「💳 クレジットカード払いに切替」を起点とする 2 ステップフロー) は本 PR で廃止。`/settings/tenant` の paymentMethod 操作起点を「請求先情報」フォームに集約することで、Step A (DB 書込) と Step B (Stripe Checkout) の中間でユーザが離脱して `paymentMethod='credit_card' + sub_id=null` の不整合 (= `credit_card_unregistered` 状態) に陥る経路を構造的に塞いだ (KDD §5.X+100/§5.X+103)。

#### server-side ガード: `CreditCardNotRegisteredError` (PR #425 / KDD §5.X+103)

UI 経由でなく curl / Postman で `PATCH /api/tenants/me/billing { paymentMethod: 'credit_card' }` を直接叩いた場合も、`tenant-self.service.ts` の `updateBillingContact` が以下を発火:

```ts
if (
  input.paymentMethod === 'credit_card' &&
  current?.paymentMethod !== 'credit_card' &&
  current?.stripeSubscriptionId == null
) {
  throw new CreditCardNotRegisteredError(); // 422 reject
}
```

これにより「カード未登録 credit_card」の状態を DB に作る経路は **構造的に存在しない** ことが保証される。事業継続性 (= 月次自動引落の確実性) に直結する severity-1 invariant。

#### 失敗時の挙動 (重要)

| ケース | 着地 URL | tenant.paymentMethod | tenant.stripeCustomerId | UI 表示 |
|---|---|---|---|---|
| ユーザが Stripe Checkout で「戻る」 | `/settings/tenant?stripe_setup=canceled` | `invoice` (変更なし) | 既に作成されていれば残る (空 Customer) | 情報トースト「登録をキャンセルしました」 |
| カード番号が誤り | Stripe Checkout 内でエラー表示、retry 可能 | `invoice` (変更なし) | 既に作成されていれば残る | (Stripe 側 UI のため自社で UI 制御不要) |
| カード拒否 (期限切れ / 発行銀行拒否) | `/settings/tenant?stripe_setup=failed&reason=card_declined` | `invoice` (変更なし) | 残る | エラートースト「カード登録に失敗しました (カード拒否)」 |
| 検証 SetupIntent 失敗 | 同上 | `invoice` (変更なし) | 残る | 同上 |
| UI バイパス (curl) で `paymentMethod='credit_card'` を直接 PATCH | 422 `CREDIT_CARD_NOT_REGISTERED` | `invoice` (変更なし) | (変化なし) | `CreditCardNotRegisteredError` で reject |

**重要**: いずれの失敗ケースでも **`tenant.paymentMethod` を 'credit_card' に変更しない**。設定前 (= invoice)
の状態を維持する。これにより「切り替えようとして失敗 → 元に戻す」という巻き戻しロジックは不要となる
(= そもそも変更していない)。

> 詳細フローは [STRIPE_TECHNICAL_DESIGN.md §A-1](../design/STRIPE_TECHNICAL_DESIGN.md) を参照。PR #425 / KDD §5.X+99〜§5.X+108。

#### 空 Customer の取り扱い

成功・失敗いずれの場合でも、Stripe 側に **Customer レコード** は作成済となる可能性がある (= setup session
作成前に `createOrGetStripeCustomer` で作成するため)。失敗時もこの Customer は残る (= 削除しない) が、
次回再試行時に再利用するため害はない。月次の Stripe 側に「カード未登録 Customer」がたまっても課金は
発生しないため運用上の問題はなし。

### 4.2 通常運用フロー (Metered Billing)

```
[テナント] API 呼び出し (= LLM 利用)
   ↓
[サーバ側] withMeteredLLM(...) でラップ
   - 既存処理 (= Tenant.currentMonthApiCallCount / currentMonthApiCostJpy を更新)
   - 追加: paymentMethod === 'credit_card' なら
     * stripe.subscriptionItems.createUsageRecord(itemId, { quantity: 1, timestamp: now })
     * Haiku 呼び出し → stripeSubscriptionItemHaikuId
     * Sonnet 呼び出し → stripeSubscriptionItemSonnetId
   ↓
[月末: 自動]
   - Stripe が Subscription Item の Usage Record を集計
   - stripe.invoices.create() で Invoice を自動生成
   ↓
[Webhook] invoice.created を受信
   ↓
[サーバ側]
   - billing_history テーブルに INSERT (yearMonth, paymentMethod='credit_card', amountJpy, taxAmountJpy, totalAmountJpy, status='pending', stripeInvoiceId)
   ↓
[月末: 数時間後] Stripe が default_payment_method で自動引き落とし実行
   ↓
[Webhook] invoice.paid を受信
   ↓
[サーバ側]
   - billing_history.status = 'paid'
   - billing_history.paidAt = now
```

### 4.3 引き落とし失敗フロー (Smart Retries + 自動 suspend)

```
[Webhook] invoice.payment_failed (1 回目失敗) を受信
   ↓
[サーバ側]
   - billing_history.status = 'failed'
   - billing_history.failureReason = event.data.object.last_finalization_error.code
   - billing_history.retryCount = 1
   - Stripe Smart Retries が自動的に次回再試行をスケジュール
   ↓
[1 日後] Stripe 自動リトライ → 成功 / 失敗
[3 日後] Stripe 自動リトライ → 成功 / 失敗
[5 日後] Stripe 自動リトライ → 成功 / 失敗
[7 日後] Stripe 最終リトライ → 成功 / 失敗
   ↓
[7 日後の失敗時 = subscription.status='past_due']
[Webhook] customer.subscription.updated (status: past_due) を受信
   ↓
[サーバ側]
   - tenant.autoSuspendScheduledAt = now + 3 日 (= 合計 10 日後)
   ↓
[cron: 日次] checkAutoSuspendScheduled() を実行
   - autoSuspendScheduledAt <= now のテナントに対し
   - suspendTenant(tenantId, 'payment_delinquent', SYSTEM_USER_ID) を呼出 (PR #372 の既存実装を再利用)
   ↓
[テナント] 次回ログイン時に強制ログアウト → middleware で TENANT_SUSPENDED 表示
```

### 4.4 プラン変更時のカード検証フロー (新要件)

ユーザの要望: 「プラン変更時、再度クレジットカード情報が誤っていないか、請求ができるかを確認する機能」

```
[テナント管理者] /settings/tenant でプラン変更 (Expert → Pro 等)
   ↓
[API] PATCH /api/tenants/me { plan: 'pro' }
   ↓
[サーバ側]
   - paymentMethod === 'credit_card' なら、まずカード検証を実行
   - verifyTenantCard(tenantId) を呼出
     1. stripe.paymentMethods.retrieve(stripeDefaultPaymentMethodId)
     2. カード期限切れチェック (= card.exp_year / exp_month が現在より前)
     3. $0 SetupIntent で「請求テスト」(= Authorization-only での検証):
        stripe.setupIntents.create({ customer, payment_method, confirm: true, usage: 'off_session' })
     4. SetupIntent.status === 'succeeded' なら OK
        SetupIntent.status === 'requires_action' なら 3D Secure 必要 → 顧客に通知
        SetupIntent.status === 'requires_payment_method' なら拒否 → エラー返却
   ↓
[検証 OK]
   - tenant.cardLastVerifiedAt = now
   - tenant.cardVerificationStatus = 'valid'
   - プラン変更を実行 (= tenant.plan = 'pro')
[検証 NG]
   - tenant.cardVerificationStatus = 'expired' / 'declined'
   - エラー返却: 400 CARD_VERIFICATION_FAILED + 顧客へカード更新案内
```

### 4.5 Customer Portal アクセスフロー

```
[テナント管理者] /settings/tenant で「カード情報 / 請求履歴を管理」ボタン押下
   ↓
[API] POST /api/tenants/me/billing/stripe/portal
   ↓
[サーバ側]
   - stripe.billingPortal.sessions.create({
       customer: stripeCustomerId,
       return_url: <host>/settings/tenant
     })
   ↓
[ブラウザ] Stripe Customer Portal にリダイレクト
   - 顧客がカード更新 / 履歴閲覧 / サブスク管理可能
   ↓
[完了時] return_url に自動リダイレクト
```

### 4.6 銀行振込戻し (= credit_card → invoice cancel) フロー (PR #425 / KDD §5.X+105 確定)

**設計方針**: cancel 経路は **Webhook を待たずアプリ層で即時 DB を更新する**。
Webhook (`customer.subscription.deleted`) は冗長 (= 整合性二重チェック) として位置付ける。

#### 旧設計の問題

旧 `cancelTenantStripeSubscription` は Stripe API でのみ cancel を呼び、DB の `stripeSubscriptionId` 等の
クリアは `customer.subscription.deleted` Webhook 経由で行っていた。これにより:

- **staging 環境** (Webhook 未設定): DB に `sub_id='sub_xxx'` が永久に残る → 再 setup 時に二重作成エラー
- **本番環境**: Webhook 同期の数秒〜数分の遅延中に「銀行振込戻し → 即カード払い再切替」を実行すると同じ race condition

```
[テナント管理者] /settings/tenant の「請求先情報」セクションで支払い方法を「銀行振込」に変更 → 「請求先情報を更新」
   ↓
[サーバ tenant-self.service.updateBillingContact]
   - paymentMethod が credit_card → invoice に変わった場合:
     1. stripe.subscriptions.cancel(stripeSubscriptionId, { invoice_now: true, prorate: false })
     2. **成功時 / 既 canceled 時 (= invalid_request 系) いずれも DB を即時クリア**:
        - stripeSubscriptionId = null
        - stripeSubscriptionStatus = 'canceled'
        - stripeSubscriptionItemHaikuId / SonnetId / StorageId = null
        - stripeDefaultPaymentMethodId = null
        - cardVerificationStatus = null
        - cardLastVerifiedAt = null
        - autoSuspendScheduledAt = null
        - stripeCustomerId は **保持** (= 再 setup 時に再利用、Customer 削除は別 API)
     3. paymentMethod = 'invoice' を確定
   ↓
[Webhook] customer.subscription.deleted を後追いで受信 — DB は既にクリア済のため no-op
```

#### 「再切替」の正常動作保証

cancel 直後 (= 秒単位) に「invoice → credit_card」へ再切替しても:
- DB の `stripeSubscriptionId=null` を見て `/setup` フローに入り、KDD §5.X+107 の Step 3.5
  (`cancelAllActiveStripeSubscriptionsForCustomer`) で念のため Stripe 側の残骸も cancel
- `createSubscriptionForTenant` の idempotencyKey に paymentMethodId を含む (KDD §5.X+106) ため、
  新カードでの新規 Subscription として作成される

これにより「銀行振込戻し → 即カード払い再切替」は **構造的に常に成功** する normal use case として保証。

> 詳細フローは [STRIPE_TECHNICAL_DESIGN.md §A-1](../design/STRIPE_TECHNICAL_DESIGN.md) を参照。PR #425 / KDD §5.X+105。

---

## §5. API 設計

### 5.1 新規 API エンドポイント

| Method | Path | 認可 | 役割 |
|---|---|---|---|
| `POST` | `/api/tenants/me/billing/stripe/setup` | admin | Stripe Checkout Session (mode='setup') を作成しカード登録画面に誘導。`success_url` は `/api/tenants/me/billing/stripe/setup/complete?session_id={CHECKOUT_SESSION_ID}` を指定 |
| `GET` | `/api/tenants/me/billing/stripe/setup/complete` | admin | Stripe Checkout 成功後の **自動完了ハンドラ**。検証 + paymentMethod 自動切替 + Subscription 作成を single transaction で実行し、`/settings/tenant?stripe_setup=success` (or `?stripe_setup=failed&reason=...`) へリダイレクト |
| `POST` | `/api/tenants/me/billing/stripe/portal` | admin | Stripe Customer Portal Session を作成 |
| `POST` | `/api/tenants/me/billing/stripe/verify` | admin | カード検証を実行 (プラン変更時の自動呼出 + 手動ボタン)。検証だけ実行し paymentMethod は変更しない |
| `PATCH` | `/api/tenants/me/billing` | admin | paymentMethod を `credit_card` → `invoice` に戻す経路のみ (= 逆方向)。`invoice` → `credit_card` への切替は本 PATCH ではなく上記 `/setup` フローで自動実行される |
| `POST` | `/api/webhooks/stripe` | **公開 (signature 検証必須)** | Stripe からの Webhook 受信 |

#### 5.1.1 1 アクションフローの設計意図 (2026-05-14 確定)

`POST /api/tenants/me/billing/stripe/setup` でカード登録を開始した時点で、ユーザは「クレジットカード払いに切り替えたい」意思表示を **1 回行っている**。中間状態 (= 「カード登録だけ済み、切替はまだ」) を持たず、`/setup/complete` ハンドラで **検証成功と同時に paymentMethod を 'credit_card' へ自動切替** することで:

- ✅ ユーザの「切替忘れ」を防止
- ✅ UI 状態モデルが A → C (成功) / A → A (失敗) の 2 経路のみで明快
- ✅ 失敗時は `tenant.paymentMethod` を変更しないため「巻き戻しロジック」が不要

#### 5.1.2 失敗時の paymentMethod 保持

`/setup/complete` ハンドラで以下のいずれかが発生した場合、`tenant.paymentMethod` は **invoice のまま変更しない** (= 設定前の状態を維持):

- Checkout Session が canceled 状態で返ってくる
- SetupIntent の検証 ($0 verification) が失敗 (= `requires_payment_method` / `requires_action`)
- カード Issuer が拒否 (`card_declined` / `expired_card` 等)
- Subscription 作成が失敗 (= Stripe API 障害等)

これにより「切替えようとしたら失敗 → 元に戻す」という補償ロジックは **不要**。

### 5.2 既存 API への影響

| ファイル | 変更内容 |
|---|---|
| `src/lib/llm/metered.ts` (`withMeteredLLM`) | paymentMethod === 'credit_card' のテナントは `stripe.subscriptionItems.createUsageRecord` を追加で呼ぶ。失敗時は **同期的に Throw せず非同期 queue に積む** (= LLM 呼び出し自体を止めない) |
| `src/services/tenant-self.service.ts` (`updateTenantPlan`) | プラン変更前に `verifyTenantCard()` を呼出。失敗時は CARD_VERIFICATION_FAILED で拒否 |
| `src/services/tenant-onboarding.service.ts` | 新規テナント作成時、デフォルト `paymentMethod = 'invoice'`、Stripe Customer は作成しない |

---

## §6. 失敗ハンドリング

### 6.1 Usage Record 送信失敗

`stripe.subscriptionItems.createUsageRecord` が失敗 (= ネットワークエラー / Stripe ダウン) した場合:

- **LLM 呼び出し自体は止めない** (顧客体験優先)
- 失敗した Usage Record は `stripe_usage_record_queue` (新規簡易テーブル) に積む
- 日次 cron (05:00 UTC) で再送 (idempotency_key で重複防止)
- 旧 Vercel Hobby プランの cron 最小間隔制約「1 日 1 回」に合わせて日次運用を開始。Netlify 移行後 (ADR-0023) は外部 cron (cron-job.org) で 1 分間隔まで設定可能だが、Stripe Usage Record の `timestamp` パラメタで実呼出時刻を送るため翌日送信でも月末請求の正確性は維持される (= 35 日以内の過去 timestamp を Stripe が受領)。ops 即時性要求が出たら短間隔に切り替え可能

### 6.2 Webhook 受信失敗

- Stripe は 3 日間自動再送する (公式仕様)
- 受信時は `StripeWebhookEvent` テーブルに INSERT (event.id で冪等性保証)
- 処理失敗は `errorMessage` に保存し、運用調査
- リカバリ: super_admin ダッシュボードに「未処理 Webhook 一覧」を追加 (MVP では SQL 直接照会で OK)

### 6.3 Stripe Subscription 状態の不整合

`Tenant.stripeSubscriptionStatus` と Stripe 側の真の状態が乖離した場合:

- 月初 cron で `stripe.subscriptions.retrieve()` で全 credit_card テナントを照合
- 不一致なら DB を Stripe 側に揃える (= Stripe を信頼源とする)

---

## §7. セキュリティ

### 7.1 Webhook シグネチャ検証

```typescript
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-12-18.acacia' });

export async function POST(req: NextRequest) {
  const signature = req.headers.get('stripe-signature');
  const body = await req.text();
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, signature, process.env.STRIPE_WEBHOOK_SECRET);
  } catch {
    return new Response('Invalid signature', { status: 400 });
  }
  // ... 処理
}
```

### 7.2 環境変数管理

| 環境変数 | 用途 | 環境ごとの分離 |
|---|---|---|
| `STRIPE_SECRET_KEY` | Stripe API 認証 | テスト/本番でキー分離 (`sk_test_xxx` / `sk_live_xxx`) |
| `STRIPE_WEBHOOK_SECRET` | Webhook 検証 | 同上 (`whsec_xxx`) |
| `STRIPE_PRICE_HAIKU` | Haiku Price ID | テスト/本番で別 ID |
| `STRIPE_PRICE_SONNET` | Sonnet Price ID | 同上 |
| `STRIPE_PRICE_STORAGE_PLUS` | Storage Plus Price ID | 同上 |
| `STRIPE_PRICE_STORAGE_PRO` | Storage Pro Price ID | 同上 |

### 7.3 PCI DSS

- カード番号は **Stripe Checkout / Customer Portal で受領** (自前で扱わない)
- 自社サーバには `pm_xxx` (= PaymentMethod ID) のみ保存
- これにより自社の PCI DSS スコープを **SAQ A レベルに最小化**

---

## §8. テスト戦略

### 8.1 単体テスト

- Stripe SDK のモック (`@stripe/stripe-mock` または `vi.mock`)
- 各サービス層 (`stripe-billing.service.ts`) で正常系 / 失敗系のケース網羅
- Webhook ハンドラの冪等性テスト (同じ event.id を 2 回送信 → 1 回しか処理されない)

### 8.2 結合テスト

- Stripe Test Mode を使った実通信テスト (CI では skip、ローカルで実行)
- テスト用カード番号: `4242 4242 4242 4242` (= 成功)、`4000 0000 0000 0341` (= attach 後 charge 失敗)、`4000 0000 0000 9995` (= insufficient_funds)

### 8.3 E2E テスト

- E2E は Stripe Checkout を経由するため、複雑度が高い → v1.x では `[ ] skip: Stripe Test Mode 統合は v2 で検討` で E2E_COVERAGE.md に登録
- 代わりに **サービス層テストで認可マトリクス + エラー変換を網羅**

---

## §9. 既存機能との整合

### 9.1 PR #371 月次請求運用との統合

- `BillingHistory` テーブルの paymentMethod カラムで `invoice` (= 銀行振込) / `credit_card` を区別
- BILLING_MONTHLY_OPERATIONS.md の月次フローは:
  - `invoice` テナント (= 銀行振込): 既存の手動 CSV エクスポート + メール送付フロー継続
  - `credit_card` テナント: 自動 (super_admin は何もしない、Stripe Dashboard / `BillingHistory` 一覧で確認のみ)

### 9.2 PR #372 read-only 強制移行 (Tenant.suspendedAt) との統合

- Stripe Smart Retries 全失敗 → 自動 `suspendTenant(reason='payment_delinquent')` 呼出
- 入金完了で Webhook `invoice.paid` 受信時に自動 `resumeTenant()` 呼出
- 手動運用と完全に同じ middleware ガード (= TENANT_SUSPENDED) を流用

### 9.3 PAYMENT_DELINQUENCY_SOP.md (滞納 SOP) との統合

- `credit_card` テナント: §0 (月次入金確認) は **不要** (= Stripe Webhook で自動検知)
- フェーズ 1〜4 の判定も Stripe `customer.subscription.status` で自動 (`active` / `past_due` / `canceled`)
- super_admin は **例外時のみ介入** (= Stripe 側で解決できないクレーム対応等)

---

## §10. 法的要件

### 10.1 利用規約への追加

v1.x で Stripe (クレジットカード自動引落) を導入する際、利用規約 ([HomePage / tasukiba-user.md `#terms`](https://teppei19980914.github.io/HomePage/ja/product/tasukiba-user/#terms)) に以下を追記する想定 (v1.0 では銀行振込のみのため未反映):

- **自動更新条項**: 月末締めの自動引き落とし、解約は前月末まで
- **解約条件**: セルフ解約は当月末で有効、当月分は請求対象
- **支払い手段変更条件**: いつでも変更可、変更月から適用
- **データ削除タイミング**: 解約 90 日後に物理削除 (既存仕様継続)

追記時は第 24 条 (本規約の変更) の手続に従い、料金・課金体系変更として 30 日以上前に登録メールへ通知する。

### 10.2 特定商取引法に基づく表記

- 既存の [/legal/specified-commercial-transactions](https://...) に Stripe 決済の利用を追記
- 「クレジットカード払い」「自動更新サブスクリプション」を明示

### 10.3 個人情報保護法

- カード番号は **自社で扱わない** (Stripe に委任) → 保護義務の対象外
- Stripe Customer ID / PaymentMethod ID は内部識別子のため個人情報には該当しない

### 10.4 インボイス制度

**当面のスタンス (2026-05-21 / feat/legal-pages-lp-integration で確定)**: 適格請求書発行事業者として未登録、今後も登録予定なし。利用規約 第 5 条 2 項および LP 特商法表記 (`#tokushoho`) で明示済。

- 顧客 (法人) は仕入税額控除を経過措置 (〜2026 年 9 月: 80% / 〜2029 年 9 月: 50%) で実施
- Stripe Tax は **無効** で運用 (= 適格請求書非対応の Invoice PDF が発行される)
- 将来 JCT 登録する場合は本セクションを更新し、LP の特商法・規約と同時に整合させる

---

## §11. 運用への影響

詳細手順は別ドキュメント:

- [docs/operations/STRIPE_SETUP.md](../operations/STRIPE_SETUP.md): Stripe Dashboard の事前セットアップ
- [docs/operations/BILLING_MONTHLY_OPERATIONS.md](../operations/BILLING_MONTHLY_OPERATIONS.md) 更新: credit_card テナントの月次運用フロー
- [docs/operations/PAYMENT_DELINQUENCY_SOP.md](../operations/PAYMENT_DELINQUENCY_SOP.md) 更新: §0 入金確認に Stripe 自動検知を追記

---

## §12. ロードマップ (PR 分割計画)

実装は 5 PR に分割する想定:

| PR | スコープ | 依存 |
|---|---|---|
| **PR #1: スキーマ + マイグレーション** | Tenant カラム追加、StripeWebhookEvent、BillingHistory テーブル | なし |
| **PR #2: Stripe Service + 環境変数** | stripe-billing.service.ts (Customer / Subscription / Usage Record の薄いラッパー)、env vars 整備 | PR #1 |
| **PR #3: API endpoints + UI** | /setup, /portal, /verify, PATCH /billing の各 route。/settings/tenant の UI 拡張 | PR #2 |
| **PR #4: Webhook ハンドラ** | /api/webhooks/stripe (= 全イベント処理 + 冪等性) | PR #1, #2 |
| **PR #5: 連携 + 自動 suspend** | withMeteredLLM への Usage Record 送信、自動 suspend cron、月次照合 cron | PR #2, #4 |

各 PR は独立してマージ可能 + テストで担保 + Stripe Test Mode の動作確認を経てから次へ進む。

---

## §13. 既知の制約・将来課題

- **同一テナント複数カード**: Stripe 上は可能だが、UI / DB は default のみ管理。v2 で複数カード対応検討
- **複数通貨**: 全課金が JPY 固定。USD / EUR 対応は v2 で検討
- **3D Secure フローのカスタマイズ**: 標準 Stripe フローに委任。EU 顧客等で問題が出たら v2 で再設計
- **個別顧客の拒否ルール**: Stripe Radar で対応可能だが MVP では未設定。詐欺被害が出たら v2 で追加
- **税率変更時の対応**: Stripe Tax が自動追従するため運用作業は不要

### 13.1 Stripe Usage Record の月境界 (= UTC) と テナント TZ 月境界の差異 (PR-V8.4 / 2026-05-19)

**設計判断**: Stripe Meter Event の `timestamp` は UTC ベースで Stripe 側に保存・集計される。
一方、たすきば内部の請求業務 (= `BillingHistory` / `tenant_monthly_usage_history` / `/admin/super/usage` CSV) は **テナント TZ ベース** で月境界を判定する (PR-V8.2 で統一)。

#### 起こりうる差異

例: Asia/Tokyo テナントが **JST 6 月 1 日 05:00** (= **UTC 5 月 31 日 20:00**) に LLM 呼出を 100 回実行した場合:

| 経路 | この 100 回はどの月に計上されるか |
|------|------------------------------|
| `BillingHistory.totalAmountJpy` (= invoice 請求書) | **6 月分** (テナント TZ 月境界基準) |
| `tenant_monthly_usage_history` snapshot | **6 月分** (同上) |
| `/admin/super/usage` CSV / 画面表示 | **6 月分** (同上) |
| **Stripe Subscription Invoice** (credit_card 払いの月次請求書) | **5 月分** (UTC 月境界基準) |

#### なぜ放置するか

1. **整合の調整コストが極めて高い** — Stripe Meter は UTC 集計が仕様。テナント TZ 補正のために `MeterEvent.timestamp` を「テナント TZ の月末まで送らずバッファ」する設計は複雑かつ Stripe Webhook 遅延と干渉
2. **顧客視点の実害は限定的** — 月跨ぎ ±9〜16h の境界に大量呼出があった場合のみ顕在化。1 ヶ月で見れば過不足ゼロ (= 単に「6 月分」が「5 月分」として課金されるだけで、合計金額は変わらない)
3. **invoice 払いテナントには影響なし** — `billing-aggregation` cron はテナント TZ で集計、Stripe を経由しないため整合
4. **credit_card 払いテナントは Stripe Invoice を真とする** — 顧客は Stripe Dashboard / メール通知で「Stripe からの請求書」を直接受け取るため、UI 表示と Stripe 請求書で月が違って見えることはない (= UI = `BillingHistory` 由来 = テナント TZ ベース、Stripe 請求書 = Stripe ベース)

#### 監視

`/admin/super/diagnostics` の以下の検知で間接観測可能:

- **API 利用量 drift** (#1): ApiCallLog SUM (テナント TZ) と Tenant counter (テナント TZ で逐次 increment) の整合性
- **Stripe Usage Record 滞留 / DLQ** (#6): ApiCallLog → Stripe 送信の整合性

両者が正常な状態で、Stripe Subscription Invoice と `BillingHistory.totalAmountJpy` が月境界 ±9〜16h のズレで僅かに乖離するのは仕様 (= 想定内)。

#### 将来課題 (v2 以降)

- Stripe MeterEvent への送信を「テナント TZ の月初到達時にバッファ放出」する設計 (= Stripe MeterEventStream で部分実現可能性)
- もしくは Stripe Meter を廃止し、月次の Stripe Invoice Item 一括登録 (`stripe.invoiceItems.create`) に切替

ただしこれは「過不足ゼロ請求」の invariant 自体は壊さないため、優先度は低い。

---

## 改修履歴

| 日付 | 変更 | PR / KDD |
|---|---|---|
| 2026-05-22 | §4.1 抜本改修 (1 ステップ強制遷移 + Step 3.5/Step 6 追加 + CreditCardNotRegisteredError + idempotencyKey 設計) + §4.6 新規追加 (cancel 時 DB 即時クリア + 二重 Subscription 構造的予防 + 「銀行振込戻し → 即カード払い再切替」の正常動作保証) | PR #425 / KDD §5.X+99〜§5.X+108 |
| 2026-05-19 | §13.1 追加: Stripe UTC / テナント TZ 月境界差異の設計判断明文化 | PR #412 (PR-V8.4) |
| 2026-05-14 | 初版策定 (v1.x 仕様確定) | docs/stripe-integration-spec |
