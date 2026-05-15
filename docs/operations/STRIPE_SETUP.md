# Stripe Dashboard セットアップ手順 (super_admin 向け)

最終更新: 2026-05-14
関連: [STRIPE_BILLING.md](../business/STRIPE_BILLING.md) / [ADR-0006](../adr/0006-stripe-metered-billing-integration.md)

本ドキュメントは、Stripe Metered Billing を導入する際に super_admin が **Stripe Dashboard 上で実施する事前セットアップ** をまとめたもの。本作業は実装 PR がマージされる前に完了させる必要がある (= 環境変数として Price ID / Webhook secret が必要なため)。

---

## §1. Stripe アカウントの準備

### 1.1 アカウント作成 / ログイン
- Stripe Dashboard: https://dashboard.stripe.com/
- 法人アカウント (個人事業主は不可) で本人確認を完了させる
- **本人確認**: 法人登記簿、代表者の身分証明、銀行口座情報を提出 (= 数営業日)

### 1.2 環境分離
- 上部の **「Test mode」トグル** で本番 / テスト環境を切替
- 本作業は **両方の環境で同じ Product / Price / Webhook を作成** する必要がある (= 環境ごとに ID が異なる)

---

## §2. Product と Price の作成

Dashboard → **Products** → **Add product**

### 2.1 Expert per-call (Haiku)

| 項目 | 値 |
|---|---|
| Name | `たすきば Expert API Call (Haiku)` |
| Description | `Expert プランの API 呼び出し従量課金 (¥10/call)` |
| **Pricing model** | **Usage-based** |
| Price | `¥10` per unit |
| **Billing period** | Monthly |
| **Usage type** | **Metered** |
| **Aggregation method** | **Sum of usage during period** |
| Tax behavior | **Exclusive** (税抜価格、Stripe Tax で消費税自動加算) |
| Tax code | `txcd_10000000` (Digital services - SaaS) |

→ 作成後、Price 詳細画面の Price ID (`price_xxxx`) をコピー → 環境変数 `STRIPE_PRICE_HAIKU` に保存

### 2.2 Pro per-call (Sonnet)

| 項目 | 値 |
|---|---|
| Name | `たすきば Pro API Call (Sonnet)` |
| Description | `Pro プランの API 呼び出し従量課金 (¥30/call)` |
| Pricing model | Usage-based |
| Price | `¥30` per unit |
| Billing period | Monthly |
| Usage type | Metered |
| Aggregation method | Sum of usage during period |
| Tax behavior | Exclusive |
| Tax code | `txcd_10000000` |

→ 環境変数 `STRIPE_PRICE_SONNET` に保存

### 2.3 Storage Add-on (Plus)

| 項目 | 値 |
|---|---|
| Name | `たすきば Storage Add-on (Plus)` |
| Description | `Storage Plus プラン (¥500/月、追加 100MB)` |
| **Pricing model** | **Standard pricing** (= recurring 固定) |
| Price | `¥500` |
| Billing period | Monthly |
| Tax behavior | Exclusive |
| Tax code | `txcd_10000000` |

→ 環境変数 `STRIPE_PRICE_STORAGE_PLUS` に保存

### 2.4 Storage Add-on (Pro Storage)

| 項目 | 値 |
|---|---|
| Name | `たすきば Storage Add-on (Pro)` |
| Description | `Storage Pro プラン (¥1,500/月、追加 1GB)` |
| Pricing model | Standard pricing |
| Price | `¥1,500` |
| Billing period | Monthly |
| Tax behavior | Exclusive |
| Tax code | `txcd_10000000` |

→ 環境変数 `STRIPE_PRICE_STORAGE_PRO` に保存

---

## §3. Stripe Tax の有効化

Dashboard → **Tax** → **Settings**

### 3.1 基本設定
- **Enable Stripe Tax** を ON
- **Origin address** (= 自社住所、運営会社の登記住所) を入力
- **JCT 登録番号** (適格請求書発行事業者番号): 国税庁から取得した `T1234567890123` 形式 13 桁を入力

### 3.2 商品ごとの Tax Code 確認
- 全 Product で `txcd_10000000` (SaaS) が設定されていることを再確認
- これにより日本の課税事業者向けには 10% の消費税が自動加算される

### 3.3 Invoice テンプレート設定
Dashboard → **Settings** → **Branding** で:
- 会社ロゴ
- カスタマーサポート連絡先 (= 請求書 PDF にフッターとして自動掲載)

---

## §4. Webhook エンドポイント設定

Dashboard → **Developers** → **Webhooks** → **Add endpoint**

### 4.1 エンドポイント情報

| 項目 | 値 |
|---|---|
| Endpoint URL | **テスト**: `https://<preview>.vercel.app/api/webhooks/stripe` (Vercel Preview)<br>**本番**: `https://<production-domain>/api/webhooks/stripe` |
| API version | **`2024-12-18.acacia`** (固定、コードと一致させる) |
| Description | `たすきば Webhook (test / production)` |

### 4.2 購読イベント (= 受信するイベントの種類)

以下を**チェック**:

| イベント | 用途 |
|---|---|
| `customer.subscription.created` | サブスク作成検知 → Tenant の subscription ID を更新 |
| `customer.subscription.updated` | サブスク状態変化 (active / past_due / canceled) を Tenant に反映 |
| `customer.subscription.deleted` | サブスク削除を検知 |
| `invoice.created` | 月末請求書生成を検知 → BillingHistory に INSERT |
| `invoice.finalized` | 請求書確定 (= 顧客へメール送付タイミング) |
| `invoice.paid` | 引き落とし成功 → BillingHistory.status = 'paid' |
| `invoice.payment_failed` | 引き落とし失敗 → Smart Retries 開始、最終失敗時 +3 日後 auto suspend |
| `payment_method.attached` | カード登録完了 → Tenant.stripeDefaultPaymentMethodId 更新 |
| `payment_method.detached` | カード削除を検知 |
| `payment_method.updated` | カード期限更新等 → 検証状態を再評価 |
| `customer.updated` | Customer 情報変更 (請求先メール等) |

### 4.3 Signing secret の取得
- エンドポイント作成後、詳細画面の **Signing secret** (= `whsec_xxxx`) をコピー
- 環境変数 `STRIPE_WEBHOOK_SECRET` に保存
- ⚠️ **テスト環境と本番環境で別の secret になる** → 環境ごとに正しい値を Vercel に設定

---

## §5. API キーの取得

Dashboard → **Developers** → **API keys**

### 5.1 Secret key
- `Standard keys` → `Secret key` (= `sk_test_xxxx` or `sk_live_xxxx`)
- ⚠️ **絶対に GitHub にコミットしない**。Vercel 環境変数 `STRIPE_SECRET_KEY` に直接登録
- 本番キーは **Restricted keys** で権限最小化することを推奨 (= 必要な権限のみ付与)

### 5.2 Publishable key (フロントエンド用)
- `Publishable key` (= `pk_test_xxxx` or `pk_live_xxxx`)
- Stripe Checkout / Elements 用、フロントエンドに埋め込み可能 (= 機密情報ではない)
- 環境変数 `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` に保存

---

## §6. Customer Portal の設定

Dashboard → **Settings** → **Billing** → **Customer portal**

### 6.1 機能の有効化
- **Subscriptions**: ✅ 顧客がサブスク詳細を閲覧可能
- **Payment methods**: ✅ 顧客がカードを更新可能
- **Invoices**: ✅ 過去の請求書 PDF をダウンロード可能
- **Cancel subscription**: ❌ **無効** (= サブスク解約は自社の `/settings/tenant` セルフ解約フローに集約)
- **Update billing information**: ✅ 請求先情報の更新可能

### 6.2 ブランディング
- ロゴ、ブランドカラー (`#xxx`)、フォントを設定
- フッターに「たすきば Knowledge Relay 運営」「特定商取引法に基づく表記」リンクを掲載

---

## §7. Smart Retries 設定

Dashboard → **Settings** → **Billing** → **Revenue recovery** → **Retry settings**

### 7.1 設定値

| 項目 | 値 | 理由 |
|---|---|---|
| Retry schedule | **Smart Retries** (= Stripe 推奨アルゴリズム) | 機械学習で最適なタイミングを選択 |
| Maximum retry attempts | **4 回** | Stripe デフォルト、業界標準 |
| Maximum retry duration | **7 日** | 7 日経っても失敗なら past_due 確定 |
| Send customer email on failure | ✅ ON | 顧客に通知 (カード期限切れ等の警告) |

### 7.2 サブスク失敗時の挙動

- 4 回リトライ全失敗 → `customer.subscription.updated` Webhook で `status: 'past_due'` 受信
- アプリ側で `tenant.autoSuspendScheduledAt = now + 3 日` をセット
- 日次 cron で `autoSuspendScheduledAt <= now` のテナントを自動 suspend

---

## §8. 環境変数まとめ (Vercel に登録)

完了後、Vercel Dashboard → Project → Settings → Environment Variables に以下を登録:

| 環境変数 | テスト環境 | 本番環境 | 用途 |
|---|---|---|---|
| `STRIPE_SECRET_KEY` | `sk_test_xxxx` | `sk_live_xxxx` | サーバ側 Stripe SDK 認証 |
| `STRIPE_WEBHOOK_SECRET` | `whsec_xxxx` (test) | `whsec_xxxx` (prod) | Webhook 署名検証 |
| `STRIPE_PRICE_HAIKU` | `price_xxxx` (test) | `price_xxxx` (prod) | Expert per-call の Price ID |
| `STRIPE_PRICE_SONNET` | `price_xxxx` (test) | `price_xxxx` (prod) | Pro per-call の Price ID |
| `STRIPE_PRICE_STORAGE_PLUS` | `price_xxxx` (test) | `price_xxxx` (prod) | Storage Plus の Price ID |
| `STRIPE_PRICE_STORAGE_PRO` | `price_xxxx` (test) | `price_xxxx` (prod) | Storage Pro の Price ID |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | `pk_test_xxxx` | `pk_live_xxxx` | フロントエンド用 (Checkout) |

### 環境変数の対象環境

- `STRIPE_SECRET_KEY` 等 (`STRIPE_*`): **Production** + **Preview** + **Development** (テスト環境では `sk_test_xxxx` を、本番環境では `sk_live_xxxx` を使用)
- `NEXT_PUBLIC_*`: 同上

---

## §9. テスト環境での動作確認

実装 PR がマージされた直後に以下を確認:

### 9.1 カード登録テスト
1. テスト用テナントで `/settings/tenant` を開く
2. 「クレジットカード払いに切替」を選択 → Stripe Checkout が開く
3. テストカード番号 `4242 4242 4242 4242` (= 成功) を入力 → 登録成功確認
4. DB の `tenant.stripeCustomerId`, `stripeDefaultPaymentMethodId` がセットされていることを確認

### 9.2 Usage Record 送信テスト
1. 切替テナントで API 呼び出しを実行 (= LLM 利用)
2. Stripe Dashboard → Subscriptions → 該当 Subscription → Usage Records タブで件数が反映されていることを確認

### 9.3 引落失敗テスト
1. テナントのカードを `4000 0000 0000 9995` (= insufficient_funds) に変更
2. Stripe Dashboard で当月分 Invoice を強制的に finalize (Manual invoicing)
3. Webhook `invoice.payment_failed` 受信を確認 → `billing_history.status = 'failed'` を確認
4. 7 日経過後 (テスト時は Stripe Dashboard で時間操作) に `autoSuspendScheduledAt` がセットされることを確認

### 9.4 Webhook の冪等性確認
1. Stripe Dashboard で同じイベントを 2 回再送
2. `stripe_webhook_events` テーブルに 1 行のみ (UNIQUE 違反で 2 回目はスキップ) を確認

---

## §10. 本番投入チェックリスト

実装 PR マージ + テスト環境動作確認後、本番投入時に確認:

- [ ] Stripe 本番アカウントで本人確認 (法人) が完了している
- [ ] 本番 Webhook エンドポイントが Production URL を指している
- [ ] 本番 API キー (`sk_live_xxxx`) が Vercel Production 環境変数に登録されている
- [ ] `STRIPE_PRICE_*` が本番環境の Price ID になっている (= テスト Price ID と混同していない)
- [ ] Stripe Tax の JCT 登録番号が正しい
- [ ] Customer Portal の「Cancel subscription」が無効化されている
- [ ] 利用規約に Stripe 決済 / 自動更新条項が反映されている
- [ ] 特定商取引法に基づく表記が更新されている

---

## §11. トラブルシューティング

| 症状 | 原因候補 | 対処 |
|---|---|---|
| Webhook が受信されない | URL 設定ミス / signature 検証失敗 | Stripe Dashboard → Webhooks → 該当エンドポイント → Event log で配信履歴確認 |
| Usage Record が反映されない | Subscription Item ID 不一致 / API キー混同 | `tenant.stripeSubscriptionItemHaikuId` が Stripe 側と一致するか確認 |
| 金額が顧客の見ているものと違う | Tax Code 設定漏れ / 税込/税抜の混同 | Stripe Tax 設定 + Price の Tax behavior を `Exclusive` (税抜) に統一 |
| 「past_due」状態から復帰しない | カード更新後の retry 失敗 | 顧客に Customer Portal でカード再登録を依頼 / Dashboard で手動 retry |
| テスト環境でカードが拒否される | 本番カードを使用 | テスト用カード番号 `4242 4242 4242 4242` を使用 |

詳細: [Stripe 公式 Troubleshooting](https://docs.stripe.com/billing/subscriptions/overview)

---

## 改訂履歴

| 日付 | 変更 | PR |
|---|---|---|
| 2026-05-14 | 初版策定 (v1.x Stripe 連携仕様確定に伴う) | docs/stripe-integration-spec |
