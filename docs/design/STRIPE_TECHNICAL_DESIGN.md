# Stripe Metered Billing 詳細技術設計

最終更新: 2026-05-25 (ADR-0019 価格改定反映)
ステータス: **詳細設計確定 + 実装済 (PR #425 で UAT 検出問題群を反映、PR #441 で ADR-0019 価格改定反映)**
関連: [STRIPE_BILLING.md](../business/STRIPE_BILLING.md) (仕様) / [ADR-0006](../adr/0006-stripe-metered-billing-integration.md) (設計判断) / [ADR-0019](../adr/0019-billable-feature-units-and-free-tier-expansion.md) (2026-05-24 価格改定) / [STRIPE_INTEGRATION_PLAN.md](../roadmap/STRIPE_INTEGRATION_PLAN.md) (実装計画)

> 🆕 **ADR-0019 (2026-05-24) 反映**: Stripe queue 投入は `BILLABLE_FEATURE_UNITS` のみ (project-upsert / suggestion-explanation / auto-tag-extract)。Haiku Price 単価 ¥5 → ¥10 (新 Price ID 発行 + ENV 切替必要)、Sonnet ¥15 据置。詳細: [ADR-0019](../adr/0019-billable-feature-units-and-free-tier-expansion.md)、運用手順: [STRIPE_SETUP.md](../operations/STRIPE_SETUP.md)

## 概要

本ドキュメントは [STRIPE_BILLING.md](../business/STRIPE_BILLING.md) で確定した仕様を **実装可能なレベル** まで詰めるための詳細設計を記録する。仕様書が「what / why」、本書が「how (実装手段)」を担う。

実装担当者は本書を読んで判断保留なく PR-S1 から実装着手できる粒度を目標とする。

---

## §A. トランザクション境界 + 整合性保証

### A-1. `setup/complete` ハンドラの 2-phase commit 問題

#### 問題

Stripe API 呼出 (= 外部 HTTP) と Prisma DB トランザクションは **アトミックにできない**。例えば:

```
1. stripe.subscriptions.create() → 成功 (sub_xxx 作成)
2. prisma.tenant.update({ stripeSubscriptionId: 'sub_xxx', paymentMethod: 'credit_card' }) → 失敗
   ↓ Stripe 側は subscription 残っているが、DB 側は古い状態
   ↓ 次回 setup でも Stripe Customer は再作成され、 orphan subscription が積み上がる
```

#### 設計判断: **「DB 先行 + Stripe 後追い + 補償処理 + Step 3.5/Step 6 で 3 点完全一致」方式 (PR #425 / KDD §5.X+103/§5.X+107/§5.X+108)**

PR #425 の UAT で以下 3 件の severity-1 問題を検出 / 修正し、Phase 1-5 → **Phase 1-6 (= Step 1 + 2 + 3 + 3.5 + 4 + 5 + 6)** に拡張:

- **Step 3.5 追加** (KDD §5.X+107): DB drift で「Stripe Customer に active Subscription が並存 → 二重課金」を構造的に予防。setup 直前に同 Customer の active Subscription を **全 cancel**
- **idempotencyKey に paymentMethodId を含める** (KDD §5.X+106): 旧 `subscription:create:${tenantId}` は「テナント生涯 1 回しか Subscription を作れない」制約。カード差替のたびに `Keys for idempotent requests can only be reused with the same parameters` エラーで永久に失敗
- **Step 6 追加** (KDD §5.X+108): Subscription 作成時に Customer.invoice_settings.default_payment_method も同期 (= アプリ画面 / Customer Portal / 実引落カード の 3 点完全一致)

```typescript
// src/services/stripe-billing.service.ts (擬似コード)
export async function completeStripeSetup(tenantId: string, setupSessionId: string): Promise<Result> {
  // Step 1: Stripe Checkout Session の検証 (= Stripe からの状態取得のみ、書き込みなし)
  const session = await stripe.checkout.sessions.retrieve(setupSessionId);
  if (session.status !== 'complete') {
    return { ok: false, reason: 'setup_not_complete' };
  }
  const customerId = session.customer as string;
  const paymentMethodId = session.setup_intent
    ? (await stripe.setupIntents.retrieve(session.setup_intent as string)).payment_method as string
    : null;
  if (!paymentMethodId) return { ok: false, reason: 'no_payment_method' };

  // Step 2: DB の暫定 commit (= 'pending' 状態)
  //   この時点で tenant.paymentMethod はまだ 'invoice' のまま、'credit_card' へは切替えない。
  //   stripeCustomerId / stripeDefaultPaymentMethodId だけ先に保存。
  await prisma.tenant.update({
    where: { id: tenantId },
    data: {
      stripeCustomerId: customerId,
      stripeDefaultPaymentMethodId: paymentMethodId,
      // paymentMethod はまだ更新しない
    },
  });

  // Step 3: SetupIntent の $0 verification (= カード有効性確認)
  //   失敗 → tenant.paymentMethod 不変で error reason 返却

  // 【新規 / PR #425 / KDD §5.X+107】 Step 3.5: 既存 active Subscription を全 cancel
  //   目的: DB drift (= DB は sub_id=null だが Stripe に active 残置) の自動修復 + 二重 Subscription 防止
  //   - 開発者が script で paymentMethod を直書きしたケース
  //   - cancelTenantStripeSubscription が呼ばれず DB だけ書き換わったケース
  //   - TC-7 (UI cancel) を経由しても Webhook 遅延中に再 setup したケース
  //   いずれも Customer に active 残骸がある状態で新規 setup されると Subscription A + B が並存し
  //   月次で両方から引落される severity-1 事故。これを構造的に防ぐ。
  await cancelAllActiveStripeSubscriptionsForCustomer(customerId);

  // Step 4: Stripe Subscription を作成 (= 外部呼出、idempotent)
  let subscription: Stripe.Subscription;
  try {
    subscription = await stripe.subscriptions.create({
      customer: customerId,
      items: [
        { price: STRIPE_PRICE_HAIKU },
        { price: STRIPE_PRICE_SONNET },
        { price: getStoragePriceId(tenant.storageAddonPlan) },
      ],
      default_payment_method: paymentMethodId,
      automatic_tax: { enabled: true },
    }, {
      // 【変更 / PR #425 / KDD §5.X+106】 paymentMethodId を含めて「カード単位の冪等性」に
      //   旧 `subscription:create:${tenantId}` は「テナント生涯 1 回」の制約になり
      //   カード再登録フロー (= TC-7 cancel 後 / カード差替) で Stripe API が
      //   「Keys for idempotent requests can only be reused with the same parameters」で reject。
      //   新 key は「同 tenantId + 同 paymentMethodId なら冪等 (リトライ安全)」「異なる paymentMethodId なら新規作成」
      idempotencyKey: `subscription:create:${tenantId}:${paymentMethodId}`,
    });
  } catch (e) {
    // 補償処理: Step 2 で書いた stripeCustomerId/PaymentMethodId はそのまま残してよい
    // (= 次回再試行時に再利用される。Customer/PaymentMethod の作成は idempotent)
    return { ok: false, reason: stripe_error_code(e) };
  }

  // Step 5: DB の最終 commit (= 'credit_card' 切替確定)
  await prisma.tenant.update({
    where: { id: tenantId },
    data: {
      stripeSubscriptionId: subscription.id,
      stripeSubscriptionStatus: subscription.status,
      stripeSubscriptionItemHaikuId: subscription.items.data.find(i => i.price.id === STRIPE_PRICE_HAIKU)?.id,
      stripeSubscriptionItemSonnetId: subscription.items.data.find(i => i.price.id === STRIPE_PRICE_SONNET)?.id,
      stripeSubscriptionItemStorageId: subscription.items.data.find(i => i.price.id === getStoragePriceId(tenant.storageAddonPlan))?.id,
      paymentMethod: 'credit_card',
      cardLastVerifiedAt: new Date(),
      cardVerificationStatus: 'valid',
    },
  });

  // 【新規 / PR #425 / KDD §5.X+108】 Step 6: Customer.invoice_settings.default_payment_method を同期
  //   目的: 3 点完全一致 (アプリ画面 = Stripe Customer Portal = 実際の月次引落カード)
  //   - Customer.default_payment_method は新規 Subscription / 単発決済の「初期値」
  //   - Subscription.default_payment_method はその Subscription 固有の引落カード (= 実引落)
  //   - 新規 Subscription を作っても Customer のデフォルトは自動更新されない (Stripe 仕様)
  //   → ユーザが Customer Portal を開くと「決済手段のデフォルト」が古いカードのままで混乱
  //   → アプリ画面と Customer Portal の表示が乖離して「ユーザは画面を信用していいか?」の不安
  //   ここで Customer 側も同期して、3 経路 (アプリ画面 / Portal / 実引落) で常に同じカードが表示されるようにする
  //   失敗時は console.warn のみで続行 (= Subscription は既に成功、Customer デフォルトは「ズレる」だけで課金事故にはならない)
  try {
    await stripe.customers.update(customerId, {
      invoice_settings: { default_payment_method: paymentMethodId },
    });
  } catch (e) {
    console.warn('[stripe] Customer.invoice_settings sync failed', { tenantId, error: e });
  }

  return { ok: true };
}

// 【新規 / PR #425 / KDD §5.X+107】 同 Customer の active Subscription を全 cancel
async function cancelAllActiveStripeSubscriptionsForCustomer(customerId: string): Promise<void> {
  const stripe = getStripe();
  const listResult = await withStripeError(() =>
    stripe.subscriptions.list({ customer: customerId, status: 'active', limit: 100 }),
  );
  if (!listResult.ok) return;
  for (const sub of listResult.value.data) {
    await withStripeError(() =>
      stripe.subscriptions.cancel(sub.id, { invoice_now: true, prorate: false }),
    );
    // 失敗時は console.warn のみで続行 (= 既 canceled / Webhook 経由で最終整合)
  }
}
```

#### 「銀行振込戻し → 即カード払い再切替」の正常動作保証 (PR #425 / KDD §5.X+105)

`cancelTenantStripeSubscription` は Stripe API での cancel 成功時 + 既 canceled 検知時の双方で
`clearTenantStripeSubscriptionFields` を呼んで DB の Stripe 関連フィールドを即時クリア (= Webhook 待ちなし)。

```typescript
async function clearTenantStripeSubscriptionFields(tenantId: string): Promise<void> {
  await prisma.tenant.update({
    where: { id: tenantId },
    data: {
      stripeSubscriptionId: null,
      stripeSubscriptionStatus: 'canceled',
      stripeSubscriptionItemHaikuId: null,
      stripeSubscriptionItemSonnetId: null,
      stripeSubscriptionItemStorageId: null,
      stripeDefaultPaymentMethodId: null,
      cardVerificationStatus: null,
      cardLastVerifiedAt: null,
      autoSuspendScheduledAt: null,
      // stripeCustomerId は保持 (= 再 setup 時に再利用)
    },
  });
}
```

これにより:
- **staging** (Webhook 未設定) でも DB drift が起きない
- **本番** で「TC-7 cancel → 即 TC-1 再切替」の race condition が発生しない

cancel 後の再 setup は KDD §5.X+106 (= idempotencyKey に paymentMethodId 含む) + §5.X+107 (= Step 3.5 で残骸 cancel) と組合さって、新カードで新規 Subscription として **必ず成功** する normal use case として保証される。

#### この設計の利点

- **DB が信頼源**: 「paymentMethod === 'credit_card' なら Stripe Subscription が必ず存在する」が invariant
- **Phase 4 失敗時のリカバリ**: Stripe Subscription は作成済だが DB は `paymentMethod='invoice'` のまま → 次回 setup 時に「既存 Subscription があれば再利用」のロジックで補正可能
- **idempotency_key で重複作成防止**: `subscription:create:${tenantId}` で同一テナントへの 2 重作成を Stripe 側で防ぐ

#### Phase 4 失敗時の検出と補償 cron

```typescript
// 日次 cron: 整合性チェック
export async function reconcileStripeIntegrity(): Promise<void> {
  // 「DB は invoice だが Stripe には Subscription が存在する」ケースを検出
  const tenantsWithOrphan = await prisma.tenant.findMany({
    where: {
      stripeCustomerId: { not: null },
      paymentMethod: { not: 'credit_card' },
      // 直近 1 時間以内に更新されたものは setup 中の可能性あり、除外
      updatedAt: { lt: new Date(Date.now() - 60 * 60 * 1000) },
    },
  });
  for (const tenant of tenantsWithOrphan) {
    const subs = await stripe.subscriptions.list({ customer: tenant.stripeCustomerId });
    const active = subs.data.find(s => s.status === 'active');
    if (active) {
      // Phase 4 失敗のリカバリ: DB を Stripe に合わせて修正
      await prisma.tenant.update({
        where: { id: tenant.id },
        data: { stripeSubscriptionId: active.id, paymentMethod: 'credit_card', ... },
      });
      // または、active を cancel して整合を取る (= 顧客に通知)
    }
  }
}
```

### A-2. idempotency key の生成戦略 (PR #425 / KDD §5.X+106 で Subscription を「カード単位」に変更)

#### 設計判断: **`<operation>:<scope>:<resource_id>` 形式 + 「リトライしたい単位」で組み立てる**

| 操作 | idempotency_key | 用途 |
|---|---|---|
| Stripe Customer 作成 | `customer:create:${tenantId}` | テナント単位で 1 度だけ (= Customer はテナントに 1 対 1) |
| Stripe Subscription 作成 | **`subscription:create:${tenantId}:${paymentMethodId}`** (★ PR #425 で `tenantId` のみ → `tenantId + paymentMethodId` に変更) | **「同じカードでの再試行」は冪等 / 「異なるカードでの再 setup」は新規作成** (= TC-7 cancel 後の再切替 / カード差替 / 試行錯誤など正常 use case 全てで成功) |
| Usage Record 送信 | `usage:${tenantId}:${callType}:${callId}` | API 呼び出しごとにユニーク (= ApiCallLog.id を `callId` に流用) |
| Customer Portal Session | `portal:${tenantId}:${cryptoRandom()}` | セッションは短命なので毎回新規 |
| Checkout Session 作成 | `checkout:setup:${tenantId}:${cryptoRandom()}` | リトライ時に新しい random で重複防止 |
| カード verify (= プラン変更時) | `card:verify:${tenantId}:${year}:${month}` | 月次最大 1 回まで冪等 |

#### Subscription 作成の idempotencyKey 設計詳説 (PR #425 / KDD §5.X+106)

**旧設計** `subscription:create:${tenantId}` の致命的欠陥:
- Stripe 冪等性仕様: 同じ `idempotencyKey` + **異なる parameters** → **エラーで reject**
- 1 回目: `default_payment_method=pm_VISA_xxx` で OK
- 2 回目 (= cancel 後の再切替で別カード): 同じ key だが `default_payment_method=pm_新カード_yyy` → Stripe API が「異なる parameters での再利用」と判定して reject
- → アプリ層で `processing_error` にラップ → ユーザに「Stripe 処理エラー (時間をおいて再試行)」表示 (= 永久に成功しない)
- 実質「1 テナント = 生涯 1 回しか Subscription を作れない」制約

**新設計** `subscription:create:${tenantId}:${paymentMethodId}`:
- **ネットワーク失敗時のリトライ** (= 同じ tenantId + 同じ paymentMethodId): Stripe が 1 回目の結果を返す (= 二重課金なし、冪等性が機能)
- **カード再登録** (= 同じ tenantId + 異なる paymentMethodId): 新規 idempotency space となり、新規 Subscription を作成

#### 一般原則 (= 「Stripe `idempotencyKey` は『リトライしたい単位』で組み立てる」)

冪等性の目的は **「ネットワーク失敗時の二重実行を防ぐ」** こと。
「同じテナントは永久に同じリソース」ではない。冪等性キーの設計時に「retry したい単位」を明確化する:

- Subscription 作成 → `tenantId + paymentMethodId` (= 同じカードでの再試行)
- 決済 → `tenantId + invoiceId + amount` (= 同じ請求書の同額再試行)
- Usage Record → `tenantId + callType + ApiCallLog.id` (= 同じ API 呼び出しの再送)

#### 例外: 「同じ key で違う body」エラー対策

Stripe は同じ `idempotency_key` で **異なる body** を送ると 400 エラーを返す。これを避けるため:

- **operations: create 系** = 「リトライしたい単位」を key に含める (例: Subscription = tenantId + paymentMethodId)
- **operations: report 系** = ApiCallLog.id 等の **真にユニークな ID** を流用 (= 重複防止が主目的)
- **operations: ephemeral** = `${tenantId}:${cryptoRandom()}` で都度新規 (= idempotent 不要)

---

## §B. エラーハンドリング詳細

### B-1. Stripe error code の全カバレッジ

#### `card_declined` の decline_code マッピング

Stripe 公式 [decline codes](https://docs.stripe.com/declines/codes) の主要パターンを UI 表示文言にマッピング:

```typescript
// src/lib/stripe-error-messages.ts
export const STRIPE_DECLINE_CODE_MESSAGES: Record<string, { ja: string; severity: 'high' | 'medium' | 'low' }> = {
  // 高: 顧客の対応が必要、明確にエラー
  insufficient_funds:       { ja: 'カード残高が不足しています', severity: 'high' },
  expired_card:             { ja: 'カードの有効期限が切れています', severity: 'high' },
  incorrect_cvc:            { ja: 'セキュリティコード (CVC) が誤っています', severity: 'high' },
  incorrect_number:         { ja: 'カード番号が誤っています', severity: 'high' },
  invalid_cvc:              { ja: 'セキュリティコード (CVC) の形式が誤っています', severity: 'high' },
  invalid_expiry_month:     { ja: 'カードの有効期限 (月) が誤っています', severity: 'high' },
  invalid_expiry_year:      { ja: 'カードの有効期限 (年) が誤っています', severity: 'high' },
  invalid_number:           { ja: 'カード番号の形式が誤っています', severity: 'high' },
  lost_card:                { ja: 'カードが紛失届出済のため使用できません (カード会社にお問い合わせください)', severity: 'high' },
  stolen_card:              { ja: 'カードが盗難届出済のため使用できません (カード会社にお問い合わせください)', severity: 'high' },
  pickup_card:              { ja: 'カードが利用停止されています (カード会社にお問い合わせください)', severity: 'high' },
  restricted_card:          { ja: 'このカードは制限されています (別のカードをお試しください)', severity: 'high' },
  // 中: カードを変えれば解決する可能性あり
  card_not_supported:       { ja: 'このカードは本サービスで利用できません (別のカードをお試しください)', severity: 'medium' },
  currency_not_supported:   { ja: 'このカードは日本円決済に対応していません', severity: 'medium' },
  duplicate_transaction:    { ja: '直近に同額の決済があります (重複の可能性)', severity: 'medium' },
  fraudulent:               { ja: '不正の疑いがあるため拒否されました (カード会社にお問い合わせください)', severity: 'medium' },
  generic_decline:          { ja: 'カードが拒否されました (カード会社にお問い合わせください)', severity: 'medium' },
  // 低: 一時的、再試行で解決する可能性
  issuer_not_available:     { ja: 'カード発行会社が一時的に応答していません (時間をおいて再試行)', severity: 'low' },
  processing_error:         { ja: 'Stripe 側で処理エラーが発生しました (時間をおいて再試行)', severity: 'low' },
  try_again_later:          { ja: '一時的なエラーです (時間をおいて再試行)', severity: 'low' },
  // フォールバック
  do_not_honor:             { ja: 'カードが拒否されました (詳細はカード会社にお問い合わせください)', severity: 'medium' },
  unknown:                  { ja: 'カードが拒否されました (詳細不明、カード会社にお問い合わせください)', severity: 'medium' },
};

export function getDeclineMessage(declineCode: string | null | undefined): { ja: string; severity: string } {
  if (!declineCode) return STRIPE_DECLINE_CODE_MESSAGES.generic_decline;
  return STRIPE_DECLINE_CODE_MESSAGES[declineCode] ?? STRIPE_DECLINE_CODE_MESSAGES.unknown;
}
```

#### Stripe API エラー全般のマッピング

`card_declined` 以外の Stripe API エラー (= `StripeAPIError`, `StripeAuthenticationError`, `StripeRateLimitError`, `StripeInvalidRequestError`, `StripeConnectionError`) も統一フォーマットで処理:

```typescript
// src/lib/stripe-error-handler.ts
export type StripeOperationResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: 'card_declined'; declineCode: string; userMessage: string }
  | { ok: false; code: 'rate_limit'; retryAfterSec: number; userMessage: string }
  | { ok: false; code: 'invalid_request'; userMessage: string }
  | { ok: false; code: 'authentication'; userMessage: string }  // = 環境変数設定ミス、運営に通知
  | { ok: false; code: 'connection'; userMessage: string }      // = ネットワーク、リトライ可
  | { ok: false; code: 'api_error'; userMessage: string };      // = Stripe 側の 5xx

export async function withStripeError<T>(fn: () => Promise<T>): Promise<StripeOperationResult<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    if (e instanceof Stripe.errors.StripeCardError) {
      const msg = getDeclineMessage(e.decline_code);
      return { ok: false, code: 'card_declined', declineCode: e.decline_code ?? 'unknown', userMessage: msg.ja };
    }
    if (e instanceof Stripe.errors.StripeRateLimitError) {
      return { ok: false, code: 'rate_limit', retryAfterSec: 5, userMessage: 'リクエストが集中しています' };
    }
    if (e instanceof Stripe.errors.StripeInvalidRequestError) {
      return { ok: false, code: 'invalid_request', userMessage: e.message };
    }
    if (e instanceof Stripe.errors.StripeAuthenticationError) {
      // 運営者ログ + アラート (= 環境変数設定ミスの可能性)
      await recordError({ severity: 'critical', source: 'stripe', message: 'auth failed' });
      return { ok: false, code: 'authentication', userMessage: '決済システムに一時的な問題が発生しています' };
    }
    if (e instanceof Stripe.errors.StripeConnectionError) {
      return { ok: false, code: 'connection', userMessage: 'ネットワーク接続エラー (時間をおいて再試行)' };
    }
    return { ok: false, code: 'api_error', userMessage: 'Stripe 側で一時的なエラーが発生しています' };
  }
}
```

### B-2. Webhook 失敗時の DLQ (Dead Letter Queue) 戦略

#### 設計判断: **「processedAt=null + retryCount で 3 段階」**

```typescript
// StripeWebhookEvent に追加カラム
model StripeWebhookEvent {
  // ...既存 (id, type, payloadJson, receivedAt, processedAt, errorMessage)
  retryCount   Int      @default(0) @map("retry_count")
  /// 次回再試行スケジュール時刻 (null = もう再試行しない、= DLQ 入り)
  nextRetryAt  DateTime? @map("next_retry_at") @db.Timestamptz
}
```

#### 再試行スケジュール

| retryCount | nextRetryAt | アラート |
|---|---|---|
| 0 (= 初回) | 受信時刻 (即座に処理) | なし |
| 1 (= 1 回失敗後) | 受信時刻 + 5 分 | なし |
| 2 (= 2 回失敗後) | 受信時刻 + 30 分 | super_admin に通知 (= mail) |
| 3 (= 3 回失敗後) | null (DLQ 入り、自動再試行停止) | super_admin に critical アラート |

#### 5 分間隔の cron で再試行

```typescript
// src/app/api/cron/stripe-webhook-retry/route.ts
export async function GET() {
  const events = await prisma.stripeWebhookEvent.findMany({
    where: {
      processedAt: null,
      nextRetryAt: { lte: new Date() },
      retryCount: { lt: 3 },
    },
    take: 50,
  });
  for (const event of events) {
    await dispatchWebhookEvent(event); // 成功時は processedAt セット、失敗時は retryCount++ & nextRetryAt 更新
  }
}
```

#### DLQ 入り (= retryCount >= 3) の取扱い

- super_admin ダッシュボード `/admin/super/stripe/dlq` (新設) で一覧表示
- 手動で「再試行」「破棄」「詳細表示」ボタン
- 累積件数が 10 件超えたら critical アラート (= 何らかの体系的問題)

### B-3. Stripe API ダウン時の挙動

#### 設計判断: **「同期処理は短期リトライ、非同期処理は queue 化」**

| 操作 | 失敗時の挙動 |
|---|---|
| **`/setup` ハンドラ** (= 顧客の同期リクエスト) | 即座にエラー返却。顧客に「時間をおいて再試行」案内。リトライは UI 側で実行 |
| **Usage Record 送信** (= API 呼び出しの裏で実行) | LLM 呼び出し自体は止めず、Usage Record は `stripe_usage_record_queue` テーブルに積む |
| **Webhook ハンドラ** (= Stripe からの非同期通知) | DB INSERT 後、処理失敗は §B-2 の retry queue へ |
| **整合性 cron** (= 日次の reconcile) | 失敗テナントを記録、次回 cron で再試行 |

#### Usage Record queue テーブル

```prisma
model StripeUsageRecordQueue {
  id              String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  tenantId        String   @map("tenant_id") @db.Uuid
  /// 'haiku' / 'sonnet' (= Subscription Item の識別、tenant の subscriptionItemId を解決)
  callType        String   @map("call_type") @db.VarChar(20)
  /// ApiCallLog.id (= idempotency_key として使う、UUID)
  apiCallLogId    String   @map("api_call_log_id") @db.Uuid
  quantity        Int      @default(1)
  /// 元の API 呼び出し時刻 (= Usage Record の timestamp として送信)
  occurredAt      DateTime @map("occurred_at") @db.Timestamptz
  /// 送信試行回数
  retryCount      Int      @default(0) @map("retry_count")
  /// 次回送信予定時刻 (null = もう送らない = エラー扱い)
  nextSendAt      DateTime? @map("next_send_at") @db.Timestamptz
  /// 送信成功時刻 (null = 未送信、Date = 完了)
  sentAt          DateTime? @map("sent_at") @db.Timestamptz
  /// 直近のエラーメッセージ
  lastError       String?   @map("last_error") @db.Text
  createdAt       DateTime  @default(now()) @map("created_at") @db.Timestamptz

  @@index([sentAt, nextSendAt], map: "idx_stripe_usage_queue_pending")
  @@index([tenantId], map: "idx_stripe_usage_queue_tenant")
  @@map("stripe_usage_record_queue")
}
```

#### 5 分間隔の送信 cron

```typescript
// src/app/api/cron/stripe-usage-record-flush/route.ts
export async function GET() {
  const pending = await prisma.stripeUsageRecordQueue.findMany({
    where: {
      sentAt: null,
      nextSendAt: { lte: new Date() },
      retryCount: { lt: 5 },
    },
    take: 100,
  });
  for (const record of pending) {
    const tenant = await prisma.tenant.findUnique({ where: { id: record.tenantId } });
    const subscriptionItemId = record.callType === 'haiku'
      ? tenant.stripeSubscriptionItemHaikuId
      : tenant.stripeSubscriptionItemSonnetId;
    if (!subscriptionItemId) {
      // テナントが既に credit_card じゃない (= invoice 戻し済) → queue から削除
      await prisma.stripeUsageRecordQueue.delete({ where: { id: record.id } });
      continue;
    }
    const result = await withStripeError(() =>
      stripe.subscriptionItems.createUsageRecord(subscriptionItemId, {
        quantity: record.quantity,
        timestamp: Math.floor(record.occurredAt.getTime() / 1000),
      }, {
        idempotencyKey: `usage:${record.tenantId}:${record.callType}:${record.apiCallLogId}`,
      })
    );
    if (result.ok) {
      await prisma.stripeUsageRecordQueue.update({
        where: { id: record.id },
        data: { sentAt: new Date() },
      });
    } else {
      await prisma.stripeUsageRecordQueue.update({
        where: { id: record.id },
        data: {
          retryCount: { increment: 1 },
          nextSendAt: nextRetryAt(record.retryCount + 1),
          lastError: result.userMessage,
        },
      });
    }
  }
}

function nextRetryAt(retryCount: number): Date | null {
  // exponential backoff: 1, 5, 15, 60, 240 分
  const delays = [1, 5, 15, 60, 240];
  const delayMin = delays[retryCount - 1];
  if (delayMin == null) return null; // = DLQ 入り
  return new Date(Date.now() + delayMin * 60 * 1000);
}
```

---

## §C. 課金計算の詳細

### C-1. Proration (按分課金) の方針

#### 設計判断: **「Stripe 一括方式」 — 当月の全 Usage を Stripe で請求 (顧客体験重視)**

月途中で `invoice` → `credit_card` 切替時の挙動を以下のように確定 (ユーザ確定 2026-05-14):

```
2026-06-15 切替の例:
- 6/1〜6/14: invoice 経由で利用 (= ApiCallLog 記録済、currentMonthApiCostJpy に計上済)
- 6/15: credit_card に切替実行
   ↓ 切替時に backfill 処理を実行 (Phase 3.5)
   ↓ 6/1〜6/14 の全 ApiCallLog を Stripe Usage Record として遡及送信
- 6/15〜6/30: credit_card 経由で利用 (= 通常通り Usage Record 送信)
- 6/30 月末: Stripe が **当月の全 Usage (6/1〜6/30)** を集計 → 7月初に Invoice 自動生成 → 引落
- 顧客は「当月の請求が 1 通だけ届く」体験
```

#### 二重計上の防止

invoice 側で計上済の `BillingHistory` レコードは、切替時に **status='replaced_by_stripe' に更新** して請求対象外とする (= 物理削除せず監査用に残す)。

```prisma
// BillingHistory.status の値追加 (詳細設計確定時に拡張)
//   'pending' / 'paid' / 'failed' / 'refunded' / 'canceled' / 'replaced_by_stripe'
```

UNIQUE 制約は当初の `(tenantId, yearMonth)` のまま維持可能 (= 同月 2 レコードを作らないため、§STRIPE_BILLING.md §2.3 の制約変更は不要)。

#### 実装 (擬似コード)

```typescript
// completeStripeSetup() に Phase 3.5 (backfill) を追加
async function completeStripeSetup(tenantId, setupSessionId) {
  // Phase 1-2: Customer 検証 + DB 暫定 commit (既存)
  // ...

  // Phase 3: Subscription 作成 (= billing_cycle_anchor を JST 月初に固定)
  const jstMonthStart = getJstMonthStartUnixSec(new Date());
  const subscription = await stripe.subscriptions.create({
    customer: customerId,
    items: [...],
    default_payment_method: paymentMethodId,
    automatic_tax: { enabled: true },
    billing_cycle_anchor: jstMonthStart, // 当月の月初に anchor
    proration_behavior: 'none',
  }, { idempotencyKey: `subscription:create:${tenantId}` });

  // 【新規】Phase 3.5: 切替前の当月 Usage を Stripe に遡及送信
  const jstMonthStartDate = new Date(jstMonthStart * 1000);
  const apiCallLogs = await prisma.apiCallLog.findMany({
    where: {
      tenantId,
      createdAt: { gte: jstMonthStartDate, lt: new Date() },
      // 課金対象のもののみ (= LLM 系、embedding 系等の有償 featureUnit)
      featureUnit: { in: getBillableFeatureUnits() },
    },
  });
  // queue に積む (= 即時送信せず、5 分間隔 cron で順次送信)
  const haikuItemId = subscription.items.data.find(i => i.price.id === STRIPE_PRICE_HAIKU)?.id;
  const sonnetItemId = subscription.items.data.find(i => i.price.id === STRIPE_PRICE_SONNET)?.id;
  for (const log of apiCallLogs) {
    const callType = inferCallType(log); // 'haiku' or 'sonnet'
    await prisma.stripeUsageRecordQueue.create({
      data: {
        tenantId,
        callType,
        apiCallLogId: log.id,           // = idempotency_key として使用
        quantity: 1,
        occurredAt: log.createdAt,       // 過去日時 (= Stripe は過去 35 日以内 OK)
        nextSendAt: new Date(),
      },
    });
  }

  // Phase 4: 切替前の BillingHistory レコードを 'replaced_by_stripe' に更新
  const currentYearMonth = getCurrentJstYearMonth();
  await prisma.billingHistory.updateMany({
    where: {
      tenantId,
      yearMonth: currentYearMonth,
      // 2026-05-15: 'bank_transfer' は 'invoice' に統合済。既存 DB レガシー値も拾うため両方含める。
      paymentMethod: { in: ['invoice', 'bank_transfer'] },
      status: 'pending', // まだ請求書発行前 (= 翌月15日まで)
    },
    data: { status: 'replaced_by_stripe' },
  });

  // Phase 5: tenant.paymentMethod = 'credit_card' に切替 (既存 Phase 4)
  await prisma.tenant.update({ where: { id: tenantId }, data: { paymentMethod: 'credit_card', ... } });
}
```

#### 注意: 切替タイミングと請求書発行タイミング

| タイミング | 想定挙動 |
|---|---|
| **当月 1〜15 日に切替** | OK。invoice 側の請求書未発行 (= 翌月15日が発行期限) なので、`status='replaced_by_stripe'` で問題なし |
| **当月 16〜31 日に切替** | OK。同上 (= 当月分の請求書は翌月15日以降に発行) |
| **翌月 1〜15 日に切替** (= 前月分の請求書発行前) | OK。前月分の請求書発行待ちレコードを `replaced_by_stripe` に。Stripe 側で前月分の Usage を backfill 送信 |
| **翌月 16 日以降に切替** (= 前月分の請求書発行後) | ⚠️ 既に invoice で請求書送付済 → 重複請求リスク。**切替時に「前月分は invoice で確定済、当月分のみ Stripe」と検知して backfill 範囲を制限** |

#### Phase 3.5 実装時の補足

- `inferCallType(log)`: ApiCallLog の `modelName` (`'claude-haiku-4-5'` / `'claude-sonnet-4-6'`) や `featureUnit` から判定
- `getBillableFeatureUnits()`: 課金対象の feature 一覧 (= 'suggestion', 'auto_tag', 'embedding', etc.) 。一覧は `src/config/billing.ts` 等で集約管理
- backfill 範囲外 (= 翌月 16 日以降切替時) は backfill しない

### C-2. Subscription Item 動的管理 (プラン変更時)

#### 設計判断: **「全アイテム並存、Usage Record 送信先のみ切替」**

Beginner / Expert / Pro はすべて同じ Subscription 上に共存し、Usage Record の送信先 Subscription Item を切り替えるだけ。

```
Subscription (= 1 つのテナント契約)
├─ Item Haiku (= STRIPE_PRICE_HAIKU)    ← Expert プラン時のみ Usage 送信
├─ Item Sonnet (= STRIPE_PRICE_SONNET)  ← Pro プラン時のみ Usage 送信
└─ Item Storage (= STRIPE_PRICE_STORAGE_*) ← 常時アクティブ
```

#### プラン変更時の挙動

```typescript
// Expert → Pro 変更時
async function updateTenantPlan(tenantId: string, newPlan: 'expert' | 'pro') {
  // Subscription Item の追加・削除なし
  // 単に tenant.plan を更新するだけ
  await prisma.tenant.update({
    where: { id: tenantId },
    data: { plan: newPlan },
  });
  // 次回 API 呼び出しから、新 plan に応じた Subscription Item に Usage 送信される
  //   - Expert → Haiku Item
  //   - Pro → Sonnet Item
}
```

#### Beginner プランの扱い

Beginner は **Stripe 課金対象外** だが、Subscription 自体は active で保持:
- Beginner プラン時は Usage Record を送信しない (= `withMeteredLLM` 内で plan チェック)
- Storage Item のみ standard (¥0) で active

これにより:
- プラン切替が **Stripe API 呼び出しなしで瞬時に完了**
- 月途中のプラン変更でも proration 計算不要

### C-3. TZ 境界 (UTC vs Asia/Tokyo)

#### 問題

| システム | 月末判定 | 例 (5月分の締日) |
|---|---|---|
| たすきば (Tenant.timezone) | Asia/Tokyo 月末 | 2026-05-31 23:59:59 JST = 2026-05-31 14:59:59 UTC |
| Stripe Subscription | UTC ベース (billing_cycle_anchor 起点) | 切替時刻によって変動 |

これらが揃わないと、**当月の Usage が翌月扱いになる** リスクあり。

#### 設計判断: **Subscription の billing_cycle_anchor を JST 月初に設定**

```typescript
// 切替時、billing_cycle_anchor を「翌月 JST 月初」に固定
function getNextJstMonthStartUnixSec(now: Date): number {
  // Asia/Tokyo の翌月 1 日 00:00:00 を UTC で表現
  const jstNow = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const nextMonth = new Date(Date.UTC(
    jstNow.getUTCFullYear(),
    jstNow.getUTCMonth() + 1, // 0-indexed なので +1 で翌月
    1, 0, 0, 0
  ));
  // JST 月初 (= UTC 前日 15:00) に補正
  return Math.floor((nextMonth.getTime() - 9 * 60 * 60 * 1000) / 1000);
}

const subscription = await stripe.subscriptions.create({
  customer: customerId,
  items: [...],
  billing_cycle_anchor: getNextJstMonthStartUnixSec(new Date()),
  proration_behavior: 'none',
  // ...
});
```

これにより:
- Stripe の月末判定が JST 月末と一致
- 切替月は Stripe Subscription が start ~ JST 月末まで稼働 (= proration_behavior='none' で按分なし、切替月は半月分のみ請求)

#### Usage Record の timestamp も JST ベースで送信

```typescript
// reportUsage で
await stripe.subscriptionItems.createUsageRecord(itemId, {
  quantity: 1,
  // JST 時刻を Unix 秒に変換 → Stripe は受け取って自動で UTC として扱うが、
  // 月末境界の判定で 9 時間ズレないよう、API 呼び出し時刻をそのまま (= UTC ベース) 送信
  timestamp: Math.floor(Date.now() / 1000),
  action: 'increment',
});
```

注: Stripe は `timestamp` を UTC 基準で扱うため、API 呼び出し時刻をそのまま送れば、`billing_cycle_anchor` (= JST 月初 = UTC 前日 15:00) との一貫性が保たれる。

---

## §D. 既存実装との配線詳細

### D-1. `withMeteredLLM` への配線箇所

#### 既存実装

`src/lib/llm/metered.ts` の `withMeteredLLM` は以下の流れ:

```
1. プラン上限チェック (= Beginner 月100回上限等)
2. 予算上限チェック (= monthlyBudgetCapJpy)
3. LLM 呼出 (= 実 API)
4. ApiCallLog 記録
5. Tenant.currentMonthApiCallCount / currentMonthApiCostJpy を increment
```

#### 配線位置: **Step 5 の直後**

```typescript
// src/lib/llm/metered.ts
export async function withMeteredLLM(tenantId, callType, fn) {
  // Step 1-3: 既存処理
  const result = await fn();

  // Step 4: ApiCallLog 記録 (既存)
  const apiCallLog = await prisma.apiCallLog.create({...});

  // Step 5: Tenant カウンタ更新 (既存)
  await prisma.tenant.update({
    where: { id: tenantId },
    data: { currentMonthApiCallCount: { increment: 1 }, ... },
  });

  // 【新規】Step 6: Stripe Usage Record 送信 (paymentMethod === 'credit_card' のみ)
  if (tenant.paymentMethod === 'credit_card') {
    // 同期送信は試みず、必ず queue 経由 (= LLM 呼び出しを止めない)
    await prisma.stripeUsageRecordQueue.create({
      data: {
        tenantId,
        callType,  // 'haiku' or 'sonnet'
        apiCallLogId: apiCallLog.id,
        quantity: 1,
        occurredAt: apiCallLog.createdAt,
        nextSendAt: new Date(), // 即送信予定
      },
    });
  }

  return result;
}
```

#### 利点

- **LLM 応答時間に影響しない**: Stripe API 呼び出しを同期実行しないため、ユーザは遅延を感じない
- **Stripe ダウン耐性**: queue に積むだけなので、Stripe API ダウン時も LLM は引き続き利用可能
- **完全性保証**: ApiCallLog.id が idempotency_key になるため、5 分間隔 cron での再送でも重複しない
- **paymentMethod 切替に追従**: 月途中で invoice → credit_card 切替後は新規 LLM 呼び出しから queue 投入される

### D-2. 自動 suspend cron の正確な動作

#### 設計判断: **「`customer.subscription.updated` Webhook 受信時刻 + 3 日」**

```typescript
// Webhook ハンドラ
async function handleSubscriptionUpdated(event: Stripe.Event) {
  const subscription = event.data.object as Stripe.Subscription;
  const tenant = await prisma.tenant.findFirst({
    where: { stripeSubscriptionId: subscription.id },
  });
  if (!tenant) return;

  // 状態を反映
  await prisma.tenant.update({
    where: { id: tenant.id },
    data: { stripeSubscriptionStatus: subscription.status },
  });

  // past_due に遷移したら自動 suspend スケジュール
  if (subscription.status === 'past_due' && tenant.stripeSubscriptionStatus !== 'past_due') {
    const suspendAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000); // 3 日後
    await prisma.tenant.update({
      where: { id: tenant.id },
      data: { autoSuspendScheduledAt: suspendAt },
    });
  }

  // active に戻ったら自動 suspend キャンセル + suspend 中なら resume
  if (subscription.status === 'active' && tenant.stripeSubscriptionStatus !== 'active') {
    await prisma.tenant.update({
      where: { id: tenant.id },
      data: { autoSuspendScheduledAt: null },
    });
    if (tenant.suspendedAt != null && tenant.suspendReason === 'payment_delinquent') {
      // 入金完了で自動 resume (= 既存 PR #372 の resumeTenant() を呼出)
      await resumeTenant(tenant.id, SYSTEM_USER_ID);
    }
  }
}
```

#### 日次 cron で suspend 実行

```typescript
// src/app/api/cron/stripe-auto-suspend/route.ts
export async function GET() {
  const candidates = await prisma.tenant.findMany({
    where: {
      autoSuspendScheduledAt: { lte: new Date(), not: null },
      suspendedAt: null, // まだ suspend されていない
      deletedAt: null,
    },
  });
  for (const tenant of candidates) {
    try {
      await suspendTenant(tenant.id, 'payment_delinquent', SYSTEM_USER_ID);
      await prisma.tenant.update({
        where: { id: tenant.id },
        data: { autoSuspendScheduledAt: null },
      });
    } catch (e) {
      // 既に suspended 等のエラーは無視
      await recordError({ severity: 'warning', source: 'cron', message: e.message, context: { tenantId: tenant.id } });
    }
  }
}
```

#### `SYSTEM_USER_ID` の取扱い

Webhook や cron からの自動 suspend では、auditLog の `userId` に何を入れるか?

**設計判断**: 専用の `system` ユーザを seed で作成し、その `id` を環境変数 `SYSTEM_USER_ID` に保存。

```typescript
// prisma/migrations/.../seed.sql
INSERT INTO users (id, tenant_id, email, name, system_role, is_active, ...)
VALUES (
  '00000000-0000-0000-0000-systemsystemid',
  '<MANAGEMENT_TENANT_ID>',
  'system@internal',
  'System (Auto)',
  'super_admin',
  false, -- ログイン不可
  ...
);
```

これにより:
- auditLog で「誰が実行したか」が明確 (= `system@internal`)
- 通常のログイン経路を持たない (= 不正利用防止)

---

## §E. その他の詳細設計事項

### E-1. Customer Portal の return_url 設計

```typescript
// src/app/api/tenants/me/billing/stripe/portal/route.ts
const session = await stripe.billingPortal.sessions.create({
  customer: tenant.stripeCustomerId,
  return_url: `${process.env.NEXTAUTH_URL}/settings/tenant?from=portal`,
}, { idempotencyKey: `portal:${tenantId}:${Date.now()}` });
return NextResponse.redirect(session.url);
```

UI 側で `?from=portal` を検知したらトーストで「Stripe ポータルから戻りました。最新の情報を表示しています」を表示 + 強制 refresh。

### E-2. Webhook から Subscription Item ID を取得するロジック

```typescript
function extractSubscriptionItemIds(subscription: Stripe.Subscription): {
  haikuItemId: string | null;
  sonnetItemId: string | null;
  storageItemId: string | null;
} {
  return {
    haikuItemId:   subscription.items.data.find(i => i.price.id === process.env.STRIPE_PRICE_HAIKU)?.id ?? null,
    sonnetItemId:  subscription.items.data.find(i => i.price.id === process.env.STRIPE_PRICE_SONNET)?.id ?? null,
    storageItemId: subscription.items.data.find(i => i.price.id?.startsWith('price_storage_'))?.id ?? null,
  };
}
```

### E-3. 環境変数の追加 (詳細設計で確定)

`STRIPE_BILLING.md §7.2` の環境変数に加え、以下を追加:

| 環境変数 | 値の例 | 用途 |
|---|---|---|
| `SYSTEM_USER_ID` | `00000000-0000-0000-0000-systemsystemid` | 自動操作 (Webhook/cron) の userId |
| `STRIPE_API_VERSION` | `2024-12-18.acacia` | コード側で固定参照する API バージョン |

### E-4. Stripe Tax 利用時の `BillingHistory.taxAmountJpy` 反映

```typescript
// invoice.created ハンドラ内
const invoice = event.data.object as Stripe.Invoice;
await prisma.billingHistory.create({
  data: {
    tenantId,
    yearMonth: getYearMonthFromInvoice(invoice),
    paymentMethod: 'credit_card',
    amountJpy: invoice.subtotal, // 税抜
    taxAmountJpy: invoice.tax ?? 0, // Stripe Tax 計算結果
    totalAmountJpy: invoice.total, // 税込
    status: 'pending',
    stripeInvoiceId: invoice.id,
  },
});
```

---

## §H. Session cookie `sameSite='lax'` 設計根拠 (PR #425 / KDD §5.X+103)

### 背景

PR #198 (2026-04-30) で `sameSite='lax'` → `'strict'` に強化済 (= CWE-1275 対策)。
当時の前提:

> 本サービスは Credentials provider のみで OAuth/SSO のクロスサイトコールバックが無く...

しかし PR #425 で Stripe Checkout (= 外部 origin `checkout.stripe.com` からの top-level GET redirect) を
本格運用に乗せたことで、当時の前提が崩れた。

### 発生事象

1. `/settings/tenant` → 「クレジットカード情報更新」→ Stripe Checkout
2. Stripe が `success_url` (= `/api/tenants/me/billing/stripe/setup/complete?...`) にブラウザリダイレクト
3. **sameSite='strict' により session cookie が外部 origin からの戻りで送信されない**
4. `/api/.../complete` handler が未認証扱いになり `/login` に強制 redirect
5. ユーザは「カード登録成功 → ログイン画面」という不可解な遷移を体験
6. DB は `paymentMethod='credit_card' + stripeSubscriptionId=null` の **「カード未登録 credit_card」状態** に陥り、月次自動引落が走らず請求漏れ → 事業継続性に直結する severity-1

### 設計判断: **`sameSite='lax'` に戻す** (`src/lib/auth.config.ts`)

```typescript
sessionToken: {
  options: {
    // PR #198 (2026-04-30): 'lax' → 'strict' に強化 (CWE-1275 対策)。
    // PR #425 (2026-05-22) ★severity-1★: 'strict' → 'lax' に戻す。
    //   理由: Stripe Checkout を新規導入したため、外部 origin (checkout.stripe.com) から
    //         自 origin への top-level GET redirect (= success_url) で sameSite='strict' は
    //         cookie を送らない → /api/.../complete handler が未認証扱い → /login に強制遷移
    //         → カード登録完了したのに UI 上は失敗扱い
    //         → DB は paymentMethod='credit_card' + sub_id=null の不整合状態に陥り請求漏れ。
    //   PR #198 当時の前提「外部 origin からのコールバックは無い」が崩れたための再緩和。
    //   GET 経由の CSRF 対策は不要 (= 副作用なし)。POST には CSRF token + CORS で別途防御。
    sameSite: 'lax',
    path: '/',
    secure: process.env.NODE_ENV === 'production',
  },
},
```

### CSRF 対策の代替防御

`'lax'` 緩和に伴い CSRF リスクが理論上 (= top-level GET 経由) 発生するが:
- **GET 経由の副作用なし**: 状態変更系 API は全て POST/PATCH/DELETE で実装
- **POST/PATCH/DELETE には CSRF token + CORS** で別途防御 (= Next.js App Router の form action + Origin header 検証)
- 外部 origin からの POST top-level navigation は `sameSite='lax'` でも cookie 送信されない (= ブラウザ仕様)

### 一般原則

**外部 origin からのコールバックを伴う機能を追加したら cookie sameSite を必ず見直す**。
旧設計の前提条件 (=「外部コールバック無し」) が後から崩れることは頻繁。Stripe / OAuth / OIDC / パスキー等を導入する際は強い候補。

---

## §I. `getStripeCardSummary` 設計: Subscription 優先取得で「画面のカード = 請求カード」一貫性を担保 (PR #425 / KDD §5.X+108)

### 背景

Stripe には **2 つの異なる default_payment_method** が存在し、混同しやすい:

| フィールド | 意味 | 設定経路 |
|---|---|---|
| `Customer.invoice_settings.default_payment_method` | 新規 Subscription / 単発決済の **初期値** | Customer Portal の「デフォルトに設定」/ Customer 作成時 / 開発者が API で明示設定 |
| `Subscription.default_payment_method` | **その Subscription 固有の引落カード** (= 実際の請求カード) | Subscription 作成時の引数 / API で別途設定 |

新規 Subscription を作っても Customer のデフォルトは自動更新されない。これにより:

1. TC-1 初回 setup: `default_payment_method=Visa pm_A` で Subscription 作成 → Customer デフォルトも Visa に
2. ユーザが Customer Portal で **Mastercard をデフォルトに変更** → `Customer.invoice_settings.default_payment_method = Mastercard`
3. ただし既存 Subscription の引落は Visa のまま (= Stripe 仕様、Subscription レベルが優先)
4. TC-7 で銀行振込戻し → Subscription cancel
5. 再度 TC-3 で新規 3DS Visa で setup → 新規 Subscription 作成 (`default_payment_method=新Visa`)
6. **`Customer.invoice_settings.default_payment_method` は依然として Mastercard** (= ステップ 2 のまま)
7. **アプリ画面**: 旧 `getStripeCardSummary` が Customer.invoice_settings を見る → Mastercard 表示 (= 古い)
8. **実際の請求**: 新 Subscription.default_payment_method = 新 Visa → Visa から引落

ユーザは画面を信頼しているため「Mastercard に請求が来る」と思っているが、実際は「Visa に請求が来る」状態。
**「画面のカード ≠ 実際に請求されるカード」** = KDD §5.X+103 で死守すべき一貫性が破綻 = severity-1 信用問題。

### 設計判断: **Subscription 優先 + Customer フォールバック** (`src/services/stripe-billing.service.ts`)

```typescript
async function getStripeCardSummary(tenantId): Promise<StripeCardSummary | null> {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { stripeCustomerId: true, stripeSubscriptionId: true },
  });
  if (!tenant?.stripeCustomerId) return null;
  const stripe = getStripe();

  // 優先: Subscription.default_payment_method (= 実際の請求カード)
  //   - これがユーザに対する「あなたのカードに毎月請求が来ます」の真実
  //   - expand で payment_method 全フィールドを取得
  if (tenant.stripeSubscriptionId) {
    const subResult = await withStripeError(() =>
      stripe.subscriptions.retrieve(tenant.stripeSubscriptionId!, {
        expand: ['default_payment_method'],
      }),
    );
    if (subResult.ok) {
      const pm = subResult.value.default_payment_method;
      if (pm && typeof pm !== 'string' && pm.type === 'card' && pm.card) {
        return {
          brand: pm.card.brand,
          last4: pm.card.last4,
          expMonth: pm.card.exp_month,
          expYear: pm.card.exp_year,
        };
      }
    }
  }

  // フォールバック: Customer.invoice_settings.default_payment_method
  //   - Subscription 未作成テナント (= setup 前)
  //   - Subscription はあるが default_payment_method 未設定の特殊ケース
  const customerResult = await withStripeError(() =>
    stripe.customers.retrieve(tenant.stripeCustomerId!, {
      expand: ['invoice_settings.default_payment_method'],
    }),
  );
  if (!customerResult.ok || customerResult.value.deleted) return null;
  const pm = customerResult.value.invoice_settings?.default_payment_method;
  if (!pm || typeof pm === 'string' || pm.type !== 'card' || !pm.card) return null;
  return {
    brand: pm.card.brand,
    last4: pm.card.last4,
    expMonth: pm.card.exp_month,
    expYear: pm.card.exp_year,
  };
}
```

### Step 6 (= Customer 同期) と組み合わせて 3 点完全一致を実現

`completeStripeSetup` Step 6 (§A-1 参照) で `stripe.customers.update({ invoice_settings: { default_payment_method } })` を実行することで、以下 3 点が **常に一致**:

1. **アプリ画面** (= `getStripeCardSummary` の戻り値 = Subscription.default_payment_method)
2. **Stripe Customer Portal** の「決済手段 / デフォルト」(= Customer.invoice_settings.default_payment_method)
3. **実際の月次引落カード** (= Subscription.default_payment_method)

Customer Portal でユーザが手動でデフォルト変更した場合はその選択を尊重 (= 上書きしない)。
次回 setup (= 新規 Subscription 作成) 時にまた新カードに同期される。

### UI 側 (`stripe-payment-method-section.tsx`) の表示制御

- `state === 'invoice_only'` のときは Stripe 側にカード履歴があっても **表示しない** (= 「画面のカード = 請求カード」一貫性の維持。銀行振込時にカード情報を表示すると「カードに請求される?」とユーザ誤解)
- `state === 'credit_card_active'` なのに `cardSummary === null` (= API 取得失敗等) のときは警告 alert を表示 (= 「⚠ カード情報を Stripe から取得できませんでした」)
- `credit_card_active` / `credit_card_attention` で `cardSummary` が取れた場合は「請求に使用されるカード (Stripe 登録情報)」として brand / last4 / 有効期限を表示

---

## §F. 各 PR (実装フェーズ) との対応

[STRIPE_INTEGRATION_PLAN.md](../roadmap/STRIPE_INTEGRATION_PLAN.md) の PR-S1〜S6 が本詳細設計のどこを参照するか:

| PR | 本書で参照する箇所 |
|---|---|
| **PR-S1: スキーマ** | §B-2 (StripeWebhookEvent 拡張カラム) / §B-3 (StripeUsageRecordQueue) / §C-1 (BillingHistory UNIQUE 制約変更) |
| **PR-S2: Service** | §A-1 (completeStripeSetup 擬似コード) / §A-2 (idempotency key) / §B-1 (エラーマッピング) / §C-2 (Subscription Item 動的管理) / §C-3 (TZ 境界) |
| **PR-S3: API** | §A-1 (route での Phase 分割) / §B-1 (UI 表示用エラー変換) |
| **PR-S4: Webhook** | §B-2 (DLQ 戦略) / §D-2 (Subscription Updated ハンドラ) / §E-4 (Invoice → BillingHistory) |
| **PR-S5: UI** | §B-1 (各 decline_code のトースト文言) / §E-1 (return_url 処理) / §I (`getStripeCardSummary` の表示制御) |
| **PR-S6: 連携** | §D-1 (withMeteredLLM 配線) / §B-3 (Usage Record queue flush cron) / §D-2 (自動 suspend cron) |
| **PR #425 後追い改修** | §A-1 Step 3.5/6 (二重 Subscription 防止 + Customer デフォルト同期) / §A-2 idempotencyKey paymentMethodId 化 / §H (sameSite='lax') / §I (`getStripeCardSummary` Subscription 優先) |

---

## §G. 既存仕様への影響反映

本詳細設計で確定した内容を踏まえ、以下の既存仕様書を後続で更新する想定:

| ファイル | 更新内容 |
|---|---|
| `STRIPE_BILLING.md` §2.3 | `BillingHistory.status` の値に `'replaced_by_stripe'` を追加 (= invoice → credit_card 切替時の置換マーク) |
| `STRIPE_BILLING.md` §6.1 | Usage Record queue テーブルの参照を追記 (= 本書 §B-3) |
| `STRIPE_INTEGRATION_PLAN.md` PR-S1 | StripeUsageRecordQueue テーブル追加 + BillingHistory.status 拡張を明記 |
| `STRIPE_INTEGRATION_PLAN.md` PR-S3 / S5 | 切替フローに Phase 3.5 (backfill) を追記 |

UNIQUE 制約 `@@unique([tenantId, yearMonth])` は **維持** (= 同月 2 レコードを作らない、切替時は invoice 側を replaced_by_stripe に更新するため)。

これらは本詳細設計レビュー完了後、別 commit で反映する。

---

## 改訂履歴

| 日付 | 変更 | PR / KDD |
|---|---|---|
| 2026-05-22 | §A-1 抜本改修 (Phase 1-5 → Step 1-6 + Step 3.5 全 active cancel + Step 6 Customer デフォルト同期 + cancel 時 DB 即時クリア) + §A-2 idempotencyKey に paymentMethodId 追加 + §H 新規 (cookie sameSite='lax' 根拠) + §I 新規 (getStripeCardSummary Subscription 優先取得) | PR #425 / KDD §5.X+103/§5.X+105/§5.X+106/§5.X+107/§5.X+108 |
| 2026-05-14 | 初版 (詳細設計確定、10 項目 + 補助 4 項目) | docs/stripe-technical-design |
