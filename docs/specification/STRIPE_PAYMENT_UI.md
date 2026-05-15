# クレジットカード払い UI 仕様 (v1.x)

最終更新: 2026-05-14
関連: [STRIPE_BILLING.md](../business/STRIPE_BILLING.md) / [ADR-0006](../adr/0006-stripe-metered-billing-integration.md)

本ドキュメントは、v1.x で導入する **クレジットカード払い + Stripe 連携** に関する画面仕様を定義する。バックエンド仕様は [STRIPE_BILLING.md](../business/STRIPE_BILLING.md) を参照。

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

## §2. `/settings/tenant` - 支払い方法セクション

### 2.1 表示位置

「プラン変更」セクションと「テナント解約」セクションの **間** に新設。

### 2.2 状態モデル (2026-05-14 確定: 1 アクション完結フロー)

**設計方針**: 「カード登録」と「クレジットカード払い切替」を **1 アクションで一体化**。中間状態
(= カード登録済だが切替前) は持たない。

| 状態 | tenant.paymentMethod | stripeCustomerId | stripeDefaultPaymentMethodId | 遷移条件 |
|---|---|---|---|---|
| **A: 未設定** | `invoice` (= 銀行振込。旧 `bank_transfer` も同状態にフォールバック) | null または既存 (= 空 Customer) | null | (初期状態) |
| **C: クレジットカード払い運用中** | `credit_card` | not null | not null | A から `/setup` → 検証成功 → C へ |
| **D: カード期限切れ / 検証失敗** | `credit_card` | not null | not null (期限切れ) | C で月次検証失敗 → D へ |

**失敗時の挙動**: A 状態で `/setup` を開始してもカード登録に失敗すれば、`tenant.paymentMethod` は変更されず A のまま (= 中間状態 B は存在しない)。

#### 状態 A: 未設定 (= paymentMethod !== 'credit_card'。旧 `bank_transfer` も含む)

```
┌─ 支払い方法 ──────────────────────────────────────┐
│ 現在の支払い方法: 🏦 銀行振込                     │
│                                                    │
│ 月末締めの翌月25日支払で、毎月請求書 PDF を       │
│ 請求担当者メールにお送りしています。              │
│                                                    │
│ ┌─────────────────────────────────────────────┐ │
│ │ 💳 クレジットカード払いに切替                │ │
│ └─────────────────────────────────────────────┘ │
│                                                    │
│ ※ ボタン押下 → Stripe Checkout (PCI DSS 準拠)    │
│   でカード入力 → 検証成功時に自動切替            │
│   失敗時 (キャンセル / 拒否) は現在の設定を維持   │
└────────────────────────────────────────────────────┘
```

#### 状態 C: クレジットカード払い運用中 (= paymentMethod === 'credit_card')

```
┌─ 支払い方法 ──────────────────────────────────────┐
│ 現在の支払い方法: 💳 クレジットカード (自動引落)  │
│                                                    │
│ 登録カード: **** 4242 (Visa) / 有効期限: 12/29   │
│ 直近の引落: 2026-06-30 ¥2,500 (税込)              │
│ 次回予定: 2026-07-31 (使用量に応じて確定)         │
│                                                    │
│ ┌─────────────────────────────────────────────┐ │
│ │ 🔧 Stripe ポータルで管理 (カード変更 / 履歴) │ │
│ └─────────────────────────────────────────────┘ │
│                                                    │
│ ┌─────────────────────────────────────────────┐ │
│ │ 🏦 銀行振込に戻す                            │ │
│ └─────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────┘
```

#### 状態 D: カード期限切れ / 検証失敗

```
┌─ 支払い方法 ──────────────────────────────────────┐
│ ⚠️ 現在の支払い方法: クレジットカード (要対応)     │
│                                                    │
│ 登録カード: **** 4242 (Visa) / **期限切れ**       │
│ 直近の検証: 2026-07-15 失敗 (expired_card)        │
│                                                    │
│ サービス停止リスク: あり (= 翌月分の引落が失敗予定)│
│                                                    │
│ ┌─────────────────────────────────────────────┐ │
│ │ 🔧 Stripe ポータルでカードを更新する         │ │
│ └─────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────┘
```

### 2.3 ボタンごとの挙動

| ボタン | API / 遷移 | 挙動 |
|---|---|---|
| 💳 クレジットカード払いに切替 (状態 A) | `POST /api/tenants/me/billing/stripe/setup` → Stripe Checkout → `GET /api/tenants/me/billing/stripe/setup/complete` (自動完了ハンドラ) | カード登録 + 検証 + paymentMethod 切替 + Subscription 作成を一括実行。成功時 `/settings/tenant?stripe_setup=success` (= 状態 C へ)、失敗時 `?stripe_setup=canceled` or `?stripe_setup=failed&reason=<code>` (= 状態 A のまま) |
| 🔧 Stripe ポータルで管理 (状態 C / D) | `POST /api/tenants/me/billing/stripe/portal` | Stripe Customer Portal を新タブで開く (= カード更新 / 履歴閲覧) |
| 🏦 銀行振込に戻す (状態 C のみ) | `PATCH /api/tenants/me/billing { paymentMethod: 'invoice' }` | 確認ダイアログ → 成功時はトースト + リロード (= Stripe Subscription は active のまま、課金経路だけ手動に戻す。再切替時は再度 `/setup` フローを通る) |

### 2.4 確認ダイアログ (= 支払い方法切替時)

**「💳 クレジットカード払いに切替」押下時** (= 状態 A → C への遷移開始時):
```
クレジットカード払いに切替えますか?

【手順】
1. 次の画面 (Stripe Checkout) でクレジットカード情報を入力
2. Stripe が即座にカードを検証 ($0 verification)
3. 検証成功 → クレジットカード払いに自動切替
   検証失敗 / キャンセル → 現在の銀行振込のまま (変更なし)

【切替成功後の挙動】
- 月末締めで Stripe が自動的に当月利用料を集計
- 翌月初に登録カードから自動引き落とし
- 領収書 PDF は Stripe から自動メール送付
- 銀行振込の手動運用は不要

【注意】
- 当月途中での切替は、その月の請求から自動引落に切り替わります
- カード期限切れ等で引落失敗が続いた場合、サービスが自動停止することがあります

[キャンセル] [カード入力画面へ進む]
```

**Stripe Checkout 戻り時のトースト表示** (= /settings/tenant への着地時):

| URL パラメタ | トースト |
|---|---|
| `?stripe_setup=success` | 🟢 成功: 「クレジットカード払いに切替えました」 |
| `?stripe_setup=canceled` | 🔵 情報: 「クレジットカード登録をキャンセルしました (現在の設定: 銀行振込のまま)」 |
| `?stripe_setup=failed&reason=card_declined` | 🔴 エラー: 「カード登録に失敗しました (カードが拒否されました)。設定は変更されていません」 |
| `?stripe_setup=failed&reason=expired_card` | 🔴 エラー: 「カード登録に失敗しました (有効期限切れ)。設定は変更されていません」 |
| `?stripe_setup=failed&reason=processing_error` | 🔴 エラー: 「カード登録に失敗しました (Stripe 処理エラー、時間をおいて再試行)。設定は変更されていません」 |
| `?stripe_setup=failed&reason=verification_required` | 🟠 警告: 「カード追加認証が必要です。Stripe からのメールをご確認のうえ、再度お試しください」 |

**「クレジットカード → 銀行振込」切替時**:
```
銀行振込に戻しますか?

【戻した後の挙動】
- 当月以降の請求は super_admin が手動で請求書 PDF を作成し、
  請求担当者メール宛に送付します
- 翌月25日が支払期限となります
- 登録済のカード情報は Stripe 側に残ります (Customer Portal で削除可能)

[キャンセル] [銀行振込に戻す]
```

---

## §3. プラン変更時のカード検証

### 3.1 プラン変更ダイアログでの挙動

`/settings/tenant` でプラン変更 (Expert → Pro 等) を実行する際、`paymentMethod === 'credit_card'` のテナントは:

```
プラン変更の確認

新プラン: Pro (¥30/call)
現プラン: Expert (¥10/call)

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

## 改訂履歴

| 日付 | 変更 | PR |
|---|---|---|
| 2026-05-14 | 初版策定 | docs/stripe-integration-spec |
