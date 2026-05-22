# クレジットカード払い UI 仕様 (v1.x)

最終更新: 2026-05-22
関連: [STRIPE_BILLING.md](../business/STRIPE_BILLING.md) / [STRIPE_TECHNICAL_DESIGN.md](../design/STRIPE_TECHNICAL_DESIGN.md) / [ADR-0006](../adr/0006-stripe-metered-billing-integration.md)

本ドキュメントは、v1.x で導入する **クレジットカード払い + Stripe 連携** に関する画面仕様を定義する。バックエンド仕様は [STRIPE_BILLING.md](../business/STRIPE_BILLING.md) を参照。

> **2026-05-22 (PR #425) 大幅改修**: TC-1〜TC-10 の UAT で多数の severity-1 不具合を検出 / 修正したため、§2 を抜本改修。
> - 「カード登録」と「クレジットカード払い切替」を独立 2 ステップにしていた旧 UI を **「請求先情報フォームで paymentMethod=credit_card に変更 → 自動 Stripe Checkout 遷移」の 1 ステップ強制遷移化** に変更 (KDD §5.X+100/§5.X+103)
> - 状態モデルを旧 A/C/D → 新 `invoice_only` / `credit_card_unregistered` / `credit_card_active` / `credit_card_attention` の 4 状態に拡張 (KDD §5.X+103)
> - Stripe 登録カード (brand / last4 / 有効期限) を **Subscription 側の default_payment_method 優先** で取得し、リアルタイム表示 (KDD §5.X+108)
> - 「画面のカード = 請求カード」一貫性原則を invariant として明文化 (KDD §5.X+103/§5.X+108)
>
> 旧 §2 の 3 状態モデルは §11 (改訂履歴) に履歴として残置。
>
> **2026-05-22 (PR #425 / KDD §5.X+109) 追加改修**: **Customer Portal 経路を撤去**。
> - Stripe 仕様で「Customer Portal の『デフォルトに設定』では既存 Subscription の引落カードが更新されない」事故を受け、本 UI から `POST /api/.../stripe/portal` 呼出を撤去
> - 「💳 クレジットカード情報更新」ボタンは **常に Stripe Checkout (新カード入力)** に遷移し、`completeStripeSetup` の「カード変更モード」で既存 Subscription の `default_payment_method` を直接 update する設計に変更
> - 「📋 請求履歴を見る」リンクを追加 (= `/settings/tenant/billing` への遷移、旧 Customer Portal の請求履歴閲覧用途を代替)
> - 本ドキュメントの本文中に残る「🔧 Stripe ポータルで管理」ボタン記述 (§2.5 ボタン表 / §3 D 状態モックアップ等) は **撤去済 (= UI に存在しない)**。本文の全網羅書き換えは後続 doc 改修 PR で実施。

---

## §1. 影響を受ける画面の一覧

| 画面 | 変更内容 | ロール |
|---|---|---|
| `/settings/tenant` | 「支払い方法」セクション新設 (= invoice/card 切替、カード登録、Customer Portal リンク、検証ボタン) | admin |
| `/settings/tenant` (プラン変更ダイアログ) | プラン変更時にカード検証 → 失敗時のエラー表示 | admin |
| `/admin/super/tenants/[id]` | paymentMethod 表示、Stripe Customer ID リンク (Stripe Dashboard へ) | super_admin |
| `/admin/super/usage` | CSV エクスポートに `payment_method` 列追加、credit_card テナントの表示色を区別 | super_admin |
| (新規) `/api/webhooks/stripe` | Webhook ハンドラ (UI なし、route のみ) | (公開 + 署名検証) |

---

## §2. `/settings/tenant` - 支払い方法セクション (2026-05-22 / PR #425 改修)

### 2.1 表示位置

「請求先情報」セクション (= paymentMethod セレクトを含むフォーム) の **直下** に「支払い方法」セクションを配置。

旧仕様で「支払い方法」セクション内に独立した「クレジットカード払いに切替」ボタンを持っていたが、PR #425 で
**paymentMethod の変更操作は上位の「請求先情報」フォームに統合** し、本セクションは
「現在の状態表示 + カード情報更新 + Stripe ポータル / 銀行振込戻し ボタン」のみを担当する。

### 2.2 状態モデル (2026-05-22 確定: 4 状態, 1 ステップ強制遷移化)

**設計方針** (KDD §5.X+103):
- 「請求先情報フォームで paymentMethod=credit_card を選択して保存」した瞬間に、サーバ側が **自動で Stripe Checkout URL に強制遷移**
- カード登録成功時のみ DB の `paymentMethod` が `credit_card` に書き換わる (= 中間状態を作らない、KDD §5.X+103)
- カード未登録のまま `paymentMethod='credit_card'` で DB に書き込む経路は、service 層 (`updateBillingContact`) の `CreditCardNotRegisteredError` (422) で UI / API バイパス双方を拒絶 (KDD §5.X+103)

| 状態 (= `derivePaymentMethodState`) | tenant.paymentMethod | stripeSubscriptionId | cardVerificationStatus / autoSuspend | 表示バッジ |
|---|---|---|---|---|
| **`invoice_only`** | `invoice` | (どちらでも) | (どちらでも) | 🏦 銀行振込 |
| **`credit_card_unregistered`** | `credit_card` | `null` | (どちらでも) | ⚠ クレジットカード払い (カード未登録 = 自動請求不可) |
| **`credit_card_active`** | `credit_card` | not null | `valid` かつ `autoSuspendScheduledAt == null` | ✅ クレジットカード払い (有効・自動引落) |
| **`credit_card_attention`** | `credit_card` | not null | `expired` / `declined` / `never_verified` または `autoSuspendScheduledAt != null` | ❌ クレジットカード払い (要対応 = 引落停止リスクあり) |

> **`credit_card_unregistered` は本来発生しないはずの不整合状態**。`updateBillingContact` の server-side ガード
> + `completeStripeSetup` の Step 5 で必ず `paymentMethod='credit_card' + stripeSubscriptionId='sub_*'` が
> セットで成立する。表示時は最大警告 (⚠ 自動請求不可) で運営側 / ユーザ双方に異常を可視化する。

#### 状態 `invoice_only` (= 銀行振込)

```
┌─ 請求先情報 (上位フォーム) ───────────────────────┐
│ 支払い方法: [銀行振込 ▼]                          │
│   ├ 銀行振込                                       │
│   └ クレジットカード                              │
│ ...                                                │
│ [請求先情報を更新]                                │
└────────────────────────────────────────────────────┘

┌─ 支払い方法 ──────────────────────────────────────┐
│ 現在の支払い方法: 🏦 銀行振込                     │
│                                                    │
│ 月末締めの翌月25日支払で、毎月請求書 PDF を       │
│ 請求担当者メールにお送りしています。              │
│ クレジットカード払いに切替えるには、上の請求先   │
│ 情報フォームで「支払い方法」を「クレジットカード」 │
│ に変更して「請求先情報を更新」を押してください    │
│ (自動でカード登録画面に進みます)。                │
│                                                    │
│ (本セクションのボタンは非活性)                    │
└────────────────────────────────────────────────────┘
```

#### 状態 `credit_card_active` (= 正常運用中)

```
┌─ 支払い方法 ──────────────────────────────────────┐
│ 現在の支払い方法: ✅ クレジットカード払い         │
│                   (有効・自動引落)                │
│                                                    │
│ 毎月末締めで Stripe が自動的に利用料を集計し、    │
│ 翌月初に登録カードから引き落とします。            │
│ 領収書 PDF は Stripe から自動メール送付されます。 │
│                                                    │
│ ┌─ 請求に使用されるカード (Stripe 登録情報) ──┐ │
│ │ Visa •••• 4242   有効期限 12/34              │ │
│ │ このカードに毎月の利用料が自動引落されます。 │ │
│ │ 変更したい場合は「クレジットカード情報更新」 │ │
│ │ ボタンをご利用ください。                     │ │
│ └────────────────────────────────────────────────┘ │
│                                                    │
│ [💳 クレジットカード情報更新]                     │
│ [🔧 Stripe ポータルで管理]                        │
└────────────────────────────────────────────────────┘
```

> 「請求に使用されるカード」表示は `getStripeCardSummary` の戻り値を描画。
> **Subscription.default_payment_method 優先取得** (KDD §5.X+108) のため、ここに表示されるカード = 実際に毎月引落されるカードと **完全一致** する。

#### 状態 `credit_card_unregistered` (= 異常 / 過渡的)

```
┌─ 支払い方法 ──────────────────────────────────────┐
│ 現在の支払い方法: ⚠ クレジットカード払い          │
│                   (カード未登録 = 自動請求不可)   │
│                                                    │
│ ★ご注意★ 支払い方法はクレジットカードに設定され │
│ ていますが、まだカードが登録されていないため自動 │
│ 請求できません。「クレジットカード情報更新」ボタン│
│ から今すぐ登録してください。                      │
│                                                    │
│ [💳 クレジットカード情報更新]                     │
└────────────────────────────────────────────────────┘
```

#### 状態 `credit_card_attention` (= カード期限切れ / 検証失敗 / autoSuspend 予定)

```
┌─ 支払い方法 ──────────────────────────────────────┐
│ 現在の支払い方法: ❌ クレジットカード払い         │
│                   (要対応 = 引落停止リスクあり)   │
│                                                    │
│ ┌─ 請求に使用されるカード ─────────────────────┐ │
│ │ Visa •••• 4242   有効期限 12/24 (期限切れ)   │ │
│ └────────────────────────────────────────────────┘ │
│                                                    │
│ ⚠️ カードの状態を確認してください                 │
│ - カードの有効期限が切れています。Stripe ポータル │
│   からカード情報を更新してください。              │
│ - (autoSuspendScheduledAt != null の場合)         │
│   引落失敗が続いており、まもなくサービスが自動   │
│   停止する予定です。                              │
│                                                    │
│ [💳 クレジットカード情報更新]                     │
│ [🔧 Stripe ポータルで管理]                        │
└────────────────────────────────────────────────────┘
```

### 2.3 切替フロー (= invoice → credit_card)

**1 ステップ強制遷移化** (KDD §5.X+103)。「請求先情報」フォームの操作で paymentMethod 変更〜カード登録〜Subscription 作成までを一気通貫:

```
[ユーザ] 「請求先情報」セクションで支払い方法を「クレジットカード」に変更
   ↓
[ユーザ] 「請求先情報を更新」ボタン押下
   ↓
[クライアント (BillingContactSection.handleSubmit)]
   isInvoiceToCreditCardTransition === true を検知:
   1. paymentMethod を除外して住所等だけ DB 更新
      → PATCH /api/tenants/me/billing { ...住所等, paymentMethod を含まず }
   2. Stripe Checkout setup URL を取得
      → POST /api/tenants/me/billing/stripe/setup
      → checkoutUrl を取得
   3. window.location.href = checkoutUrl (= 強制遷移)
   ↓
[Stripe Checkout] カード入力 → 「保存」
   ↓
[サーバ /setup/complete] 検証 + Subscription 作成 (Step 1-6)
   ↓
   成功 → /settings/tenant?stripe_setup=success
        → paymentMethod='credit_card' + sub_id='sub_*' (= credit_card_active)
   失敗 → /settings/tenant?stripe_setup=failed&reason=<code>
        → paymentMethod='invoice' のまま (= invoice_only)
```

> 旧仕様の独立した「💳 クレジットカード払いに切替」ボタンは廃止 (= UI 上から消失)。代わりに paymentMethod セレクトの変更が起点となる。

### 2.4 表示文言 (= 状態バッジ + カード情報) の明示化 (PR #425 / KDD §5.X+103/§5.X+108)

#### 状態バッジ (= 現在の支払い方法ラベル)

ユーザが画面遷移直後に「請求準備が整っているか」を一目で判断できるよう、4 状態それぞれに **絵文字 + 短い形容** を付与:

| 状態 | currentLabel |
|---|---|
| `invoice_only` | `🏦 銀行振込` |
| `credit_card_unregistered` | `⚠ クレジットカード払い (カード未登録 = 自動請求不可)` |
| `credit_card_active` | `✅ クレジットカード払い (有効・自動引落)` |
| `credit_card_attention` | `❌ クレジットカード払い (要対応 = 引落停止リスクあり)` |

旧仕様の `💳 クレジットカード (自動引落)` は「正常 / 異常」を区別しないため、本 PR で `✅ / ⚠ / ❌` で 3 段階を明示。

#### Stripe 登録カード情報のリアルタイム表示

`credit_card_active` / `credit_card_attention` では、Stripe API から取得した brand / last4 / 有効期限を表示:

```
請求に使用されるカード (Stripe 登録情報)
Visa •••• 4242   有効期限 12/34
このカードに毎月の利用料が自動引落されます。
変更したい場合は「クレジットカード情報更新」ボタンをご利用ください。
```

- 取得元: `getStripeCardSummary(tenantId)` (`src/services/stripe-billing.service.ts`)
- **取得ロジック**: Subscription.default_payment_method を優先、フォールバックで Customer.invoice_settings.default_payment_method (KDD §5.X+108)
- `invoice_only` 状態では表示しない (= 「画面のカード = 請求カード」一貫性、銀行振込時にカード表示すると「カードに請求される?」と誤解させる)
- `credit_card_active` なのに取得失敗 (= API エラー / detach 等) の場合は警告 alert を表示 (= 「⚠ カード情報を Stripe から取得できませんでした」)

#### 「画面のカード = 請求カード」一貫性原則 (KDD §5.X+103/§5.X+108)

本 UI 仕様は以下の 3 点完全一致を invariant として死守:

1. **アプリ画面** (= 本セクションの「請求に使用されるカード」表示 = `getStripeCardSummary` の戻り値)
2. **Stripe Customer Portal** の「決済手段 / デフォルト」表示
3. **実際の月次引落カード** (= Subscription.default_payment_method)

これを満たすために:
- `getStripeCardSummary` は Subscription 優先で取得 (= 実引落カードを画面に表示)
- `completeStripeSetup` の Step 6 で `stripe.customers.update({ invoice_settings: { default_payment_method } })` を実行し、Customer Portal の表示も Subscription と同期 (KDD §5.X+108 追加修正)
- 銀行振込モードでは過去のカード情報を一切表示しない

### 2.5 ボタンごとの挙動 (PR #425 改修後)

| ボタン | 表示条件 | API / 遷移 | 挙動 |
|---|---|---|---|
| 💳 クレジットカード情報更新 | `state !== 'invoice_only'` (= 3 状態すべて活性、`invoice_only` では非活性) | `POST /api/tenants/me/billing/stripe/setup` → `checkoutUrl` 取得 → `window.location.href` で Stripe Checkout に遷移 | カード新規登録 / 差し替え。完了後は `/api/tenants/me/billing/stripe/setup/complete` ハンドラで Subscription 作成 + Customer デフォルト同期 + DB 確定 |
| 🔧 Stripe ポータルで管理 | `state === 'credit_card_active' / 'credit_card_attention'` | `POST /api/tenants/me/billing/stripe/portal` | Stripe Customer Portal を別タブで開く |
| 🏦 銀行振込に戻す | `state === 'credit_card_active' / 'credit_card_attention'` (= 上位「請求先情報」フォーム経由) | 「請求先情報」フォームで支払い方法を「銀行振込」に変更して保存 → サーバ側で `cancelTenantStripeSubscription` 実行 | Stripe Subscription を cancel + DB の Stripe 関連フィールドを **即時クリア** (KDD §5.X+105、Webhook 待ちなし)。再切替時は新規 Subscription として作成 |

### 2.6 Stripe Checkout 戻り時のトースト表示

| URL パラメタ | トースト |
|---|---|
| `?stripe_setup=success` | 🟢 成功: 「クレジットカード払いに切替えました」 |
| `?stripe_setup=canceled` | 🔵 情報: 「クレジットカード登録をキャンセルしました (現在の設定: 銀行振込のまま)」 |
| `?stripe_setup=failed&reason=card_declined` | 🔴 エラー: 「カード登録に失敗しました (カードが拒否されました)。設定は変更されていません」 |
| `?stripe_setup=failed&reason=expired_card` | 🔴 エラー: 「カード登録に失敗しました (有効期限切れ)。設定は変更されていません」 |
| `?stripe_setup=failed&reason=processing_error` | 🔴 エラー: 「カード登録に失敗しました (Stripe 処理エラー、時間をおいて再試行)。設定は変更されていません」 |
| `?stripe_setup=failed&reason=verification_required` | 🟠 警告: 「カード追加認証が必要です。Stripe からのメールをご確認のうえ、再度お試しください」 |

### 2.7 確認ダイアログ

**「請求先情報を更新」押下時** (= invoice → credit_card 遷移検知時、自動で Stripe Checkout に進む前):
```
クレジットカード払いに切替えますか?

【手順】
1. 「請求先情報を保存しました。続けてカード登録画面に移動します」
2. 自動で Stripe Checkout (PCI DSS 準拠) に遷移
3. カード入力 → 「保存」
4. Stripe が検証 ($0 verification) → 成功時のみ DB に paymentMethod='credit_card' を確定
   検証失敗 / キャンセル → 現在の銀行振込のまま (変更なし)

【注意】
- 当月途中での切替は、その月の請求から自動引落に切り替わります
- カード期限切れ等で引落失敗が続いた場合、サービスが自動停止することがあります

[キャンセル] [カード入力画面へ進む]
```

**「クレジットカード → 銀行振込」切替時** (= 「請求先情報」フォームで支払い方法を「銀行振込」に変更して保存):
```
銀行振込に戻しますか?

【戻した後の挙動】
- 当月以降の請求は super_admin が手動で請求書 PDF を作成し、
  請求担当者メール宛に送付します
- 翌月25日が支払期限となります
- Stripe Subscription は即時 cancel され、DB の Stripe 関連フィールドも即時クリアされます
  (KDD §5.X+105: Webhook 待ちで race condition が起きないよう即時クリア)
- 再びクレジットカード払いに戻したくなった場合は、上記の 1 ステップ強制遷移フローで
  新規 Subscription として再作成されます

[キャンセル] [銀行振込に戻す]
```

> PR #425 / KDD §5.X+99〜§5.X+108 を参照。

---

## §3. プラン変更時のカード検証

### 3.1 プラン変更ダイアログでの挙動

`/settings/tenant` でプラン変更 (Expert → Pro 等) を実行する際、`paymentMethod === 'credit_card'` のテナントは:

```
プラン変更の確認

新プラン: Pro (¥15/call)
現プラン: Expert (¥5/call)

🔍 クレジットカードを検証中...
   - カード期限を確認中...
   - 試験的な請求テスト ($0) を実行中...

[キャンセル] [プラン変更を実行 (検証成功後)]
```

### 3.2 検証成功時

```
✅ カード検証 OK
   - カード: **** 4242 (Visa) / 有効期限 12/29
   - 検証日時: 2026-07-15 14:30

プラン変更を実行できます。
新プラン (Pro) は今すぐ有効化されます。

[キャンセル] [プラン変更を実行]
```

### 3.3 検証失敗時

```
⚠️ カード検証失敗

エラー: クレジットカードの有効期限が切れています
カード: **** 4242 (Visa) / 有効期限 12/24

プラン変更前にカード情報を更新してください。

┌─────────────────────────────────────────┐
│ 🔧 Stripe ポータルでカードを更新する     │
└─────────────────────────────────────────┘

カード更新後、再度プラン変更をお試しください。

[閉じる]
```

### 3.4 検証失敗の代表例

| エラーコード | UI 表示メッセージ |
|---|---|
| `expired_card` | クレジットカードの有効期限が切れています |
| `card_declined` | カードが拒否されました (カード会社にお問い合わせください) |
| `insufficient_funds` | カード残高が不足しています (検証時の $0 でも失敗するケース) |
| `incorrect_cvc` | カード情報に誤りがあります |
| `processing_error` | Stripe 側で処理エラーが発生しました (時間をおいて再試行) |

---

## §4. super_admin 画面の変更

### 4.1 `/admin/super/tenants/[id]` (テナント詳細)

「請求情報」セクションに以下を追加:

```
┌─ 請求情報 ────────────────────────────────────────┐
│ 支払い方法: 💳 クレジットカード (Stripe 自動引落) │
│                                                    │
│ Stripe Customer ID: cus_xxxxxxxxxxxxxx           │
│   → [Stripe Dashboard で開く]                     │
│                                                    │
│ Subscription Status: active                       │
│ Default Payment Method: **** 4242 (Visa, 12/29)  │
│ カード検証状態: ✅ valid (2026-07-15 検証)        │
│                                                    │
│ ── 当月の請求 ──                                   │
│ Invoice ID: in_xxxxxxxxxxxxxx                     │
│ 状態: pending (= 月末に確定予定)                  │
│ 予定額: ¥2,500 (LLM ¥2,000 + Storage ¥500)       │
└────────────────────────────────────────────────────┘
```

「Stripe Dashboard で開く」リンクは別タブで `https://dashboard.stripe.com/customers/cus_xxx` を開く。

### 4.2 `/admin/super/usage` (使用量 CSV エクスポート)

CSV のヘッダに以下を追加:

- `支払い方法` 列 (= invoice (= 銀行振込) / credit_card)
- `Stripe Customer ID` 列 (= credit_card のみ値、他は空)
- `引落状況` 列 (= credit_card のみ: pending / paid / failed、他は手動の status)

画面表示でも色分け:
- 🟢 緑: credit_card + paid
- 🟡 黄: credit_card + pending (= 月末待ち)
- 🔴 赤: credit_card + failed (= Smart Retries 中 / 自動 suspend 直前)
- 🔵 青: invoice (= 銀行振込、手動運用)

---

## §5. アクセシビリティ

- 全ボタンに `aria-label` を設定
- 確認ダイアログは role="dialog" + focus trap
- カード番号表示は `**** 4242` 形式で、スクリーンリーダー向けに「カード末尾 4242」と読み上げ
- エラーメッセージは `aria-live="polite"` で動的アナウンス
- 色だけで状態を伝えない (= アイコン + テキストで補完: 🟢 ✅ paid, 🔴 ⚠️ failed 等)

---

## §6. エラー画面 / Stripe 側エラーのハンドリング

### 6.1 Stripe Checkout キャンセル

ユーザが Checkout 画面で「戻る」を押した場合:
- `cancel_url` = `/settings/tenant?stripe_setup=canceled` にリダイレクト
- 表示: `ℹ️ クレジットカード登録をキャンセルしました` (= 情報トーストのみ、エラー扱いしない)

### 6.2 Stripe API ダウン

`/api/tenants/me/billing/stripe/setup` 等で Stripe API が 5xx を返した場合:
- 表示: `⚠️ クレジットカード機能が一時的に利用できません。時間をおいて再度お試しください` (= フォールバック)
- 既存の `invoice` 払いは引き続き利用可能 (= 影響を受けない)

### 6.3 Webhook 遅延でカード未反映

カード登録直後に画面を見て「**** 4242」が表示されていない場合:
- 「最新の状態を取得中...」のローディング表示 (= 最大 5 秒、ポーリング)
- 5 秒経過しても反映されない場合、`window.location.reload()` で強制リロード

---

## §7. レスポンシブ

- モバイル (< 768px): セクションごとに縦積み、ボタンは横幅 100%
- タブレット (768-1024px): 2 カラムで「現在の状態」「アクション」を並列
- デスクトップ (> 1024px): 上記モックの通り

---

## §8. テスト計画

### 8.1 単体テスト (Vitest)

- 各 React コンポーネントの状態遷移 (A → B → C → D)
- ボタン click → 適切な API 呼出 (= モックで確認)
- エラー状態の表示 (= プロップで各エラーコードを渡す)

### 8.2 E2E テスト

- E2E は Stripe Checkout を経由するため、**v2 で検討**
- 代わりにサービス層テスト + 各画面の RTL (React Testing Library) テストで担保
- `docs/test/E2E_COVERAGE.md` に新規 `[ ] /settings/tenant の支払い方法セクション` を `skip: Stripe Test Mode との結合は v2` で追加

---

## §9. 関連ドキュメント

- バックエンド仕様: [STRIPE_BILLING.md](../business/STRIPE_BILLING.md)
- 設計判断: [ADR-0006](../adr/0006-stripe-metered-billing-integration.md)
- Stripe Dashboard 設定: [STRIPE_SETUP.md](../operations/STRIPE_SETUP.md)
- 支払い条件: [PAYMENT_TERMS.md](../business/PAYMENT_TERMS.md)
- 既存 UI ベース: `/settings/tenant` ([tenant-settings-client.tsx](../../src/app/(dashboard)/settings/tenant/tenant-settings-client.tsx))

---

## §10. 改訂履歴

| 日付 | 変更 | PR / KDD |
|---|---|---|
| 2026-05-22 | §2 抜本改修: ① 状態モデルを旧 A/C/D の 3 状態 → 新 invoice_only / credit_card_unregistered / credit_card_active / credit_card_attention の 4 状態に拡張、② paymentMethod 切替を 1 ステップ強制遷移化 (「請求先情報フォームで paymentMethod 変更 → 自動 Stripe Checkout 遷移」)、③ 状態バッジ (✅/⚠/❌/🏦) を currentLabel に明示、④ Stripe 登録カード (brand/last4/exp) のリアルタイム表示を追加、⑤ 「画面のカード = 請求カード」一貫性原則 (3 点完全一致) を明文化、⑥ 銀行振込戻し時に Stripe Subscription を即時 cancel + DB 即時クリアの挙動を反映 | PR #425 / KDD §5.X+100/§5.X+103/§5.X+105/§5.X+108 |
| 2026-05-14 | 初版策定 (旧 3 状態モデル A/C/D、独立した「クレジットカード払いに切替」ボタン経由の 2 ステップフロー)。旧版は本表より前の Git 履歴を参照 | docs/stripe-integration-spec |

### 旧仕様 (= 2026-05-22 PR #425 で廃止) のサマリ (歴史的記録)

- **旧 3 状態モデル**: A (未設定) / C (運用中) / D (期限切れ・要対応)。中間状態 B (= カード登録済だが切替前) を持たない設計だったが、ガード未整備で実際には `paymentMethod='credit_card' + stripeSubscriptionId=null` の不整合状態 (= 新 `credit_card_unregistered` 状態) が発生していた
- **旧 2 ステップフロー**: 「支払い方法」セクション内の独立ボタン「💳 クレジットカード払いに切替」を押下 → Stripe Checkout → 戻り完了ハンドラで paymentMethod 切替。ボタンが「支払い方法」セレクトと独立していたため、ユーザが Step A だけ完了して Step B をスキップすると DB 不整合に陥った (KDD §5.X+100/§5.X+103)
- **旧 currentLabel**: `💳 クレジットカード (自動引落)` のみで、正常 / 異常の区別なし。新 UI は `✅ / ⚠ / ❌` で 3 段階明示
