# クレジットカード払い動作確認 テスト手順

> **対象機能**: PR #411 (Phase 4 Stripe 統合) で実装されたクレジットカード払い機能
> **検証環境**: Netlify Deploy Preview (= PR ごとの自動 build) または Branch Deploy
> **Stripe モード**: **Test mode 必須** (`sk_test_*` / `pk_test_*`)。Live mode (実カード課金) では絶対に実施しない

---

## 1. 検証環境の選択

### 1.1 推奨環境

クレジットカード払いの動作確認は、本番相当環境 (= Netlify Deploy Preview or Branch Deploy) で実施する。**ローカル `pnpm dev` での検証はネットワーク固有の問題 (Edge runtime / Stripe Webhook 配信経路 / NextAuth Set-Cookie 等) を見逃すため非推奨**。

| 環境 | 用途 | URL |
|---|---|---|
| **Deploy Preview** | PR ごとの個別検証 (= ステージング) | `https://deploy-preview-NNN--tasukiba.netlify.app` |
| **Branch Deploy** | 固定 URL での反復検証 (Stripe Webhook 固定先) | `https://<branch-name>--tasukiba.netlify.app` |

各 build の使い分け詳細は [`DEPLOYMENT.md §3`](../operations/DEPLOYMENT.md#3-開発フロー-ローカル--ステージング--本番) を参照。

### 1.2 Stripe Test mode の確認

検証環境 (Deploy Preview / Branch Deploy) の env vars が **Test mode** になっていることを必ず確認:

```bash
# Netlify Admin → Site configuration → Environment variables で確認
STRIPE_SECRET_KEY      = sk_test_...   # ← test_ で始まること
STRIPE_WEBHOOK_SECRET  = whsec_...
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY = pk_test_...
STRIPE_ENABLED         = true
```

**`sk_live_*` で始まっている場合は実カード課金が発生するため、絶対にテストしないこと**。

---

## 2. Stripe Test Cards (公式)

> **公式リファレンス**: https://docs.stripe.com/testing#cards
>
> 本サービスは Stripe Test mode (= サンドボックス) でのカード検証に **公式テストカード番号のみ** を使用します。
> 実カード番号を Test mode で入力すると Stripe が「テストカードではない」エラーで弾きます (= 安全装置)。
> 本番運用では実カードのみが使えます (= Live mode key と Test mode key を環境変数で切替)。

### 2.1 主要テストカード (= 本サービスの TC で使用)

| カード番号 | ブランド | 用途 | 期待挙動 |
|---|---|---|---|
| `4242 4242 4242 4242` | Visa | 通常成功 | `succeeded` |
| `5555 5555 5555 4444` | Mastercard | 通常成功 | `succeeded` |
| `3782 822463 10005` | AMEX | 通常成功 | `succeeded` |
| `3566 0020 2036 0505` | JCB | 通常成功 | `succeeded` |
| `4000 0000 0000 0002` | Visa | カード拒否 (汎用) | `card_declined` |
| `4000 0000 0000 9995` | Visa | 残高不足 | `insufficient_funds` |
| `4000 0027 6000 3184` | Visa | 3D Secure 認証必須 | 認証画面後 `succeeded` |
| `4000 0000 0000 0341` | Visa | 添付成功 / 月次課金拒否 | webhook `invoice.payment_failed` |
| `4000 0025 0000 3155` | Visa | 3DS 認証必須 (代替) | 認証画面後 `succeeded` |

### 2.2 その他テストカード (= 必要に応じて使用)

| カード番号 | 用途 |
|---|---|
| `4000 0000 0000 0069` | カード有効期限切れ |
| `4000 0000 0000 0127` | 不正な CVC |
| `4000 0000 0000 0119` | 処理中エラー (= processing_error) |
| `4000 0000 0000 0259` | 3DS 認証失敗 (= ユーザが認証を拒否したケース) |

→ より網羅的なテストカードは公式 https://docs.stripe.com/testing#cards 参照。

### 2.3 その他フィールド (= テストモード時の入力値、すべて任意)

| フィールド | 入力例 |
|---|---|
| 有効期限 | 任意未来日 (例: `12/34`, `05/55`) |
| CVC | 任意 3 桁 (例: `123`, `555`) |
| 郵便番号 | 任意 (例: `100-0001`) |
| カード名義 | 任意ローマ字 (例: `test`, `TEST USER`) |
| 国/地域 | 日本 (デフォルト) |

---

## 3. テストケース分類 (Webhook 要否別)

実装上、Stripe Subscription の作成・状態取得は **Stripe API の同期レスポンス経由** で DB に即時反映される ([stripe-billing.service.ts:332-343](../../src/services/stripe-billing.service.ts#L332-L343))。**Webhook は非同期イベント (= 課金失敗通知 / 冪等性検証等) でのみ必要**。

| 分類 | テストケース | Webhook 必要性 |
|---|---|---|
| **共通フロー** | TC-1, TC-2, TC-3, TC-6, TC-7, TC-8, TC-9, TC-10 | ❌ 不要 (Stripe API 同期で完結) |
| **Webhook 系** | TC-4, TC-5 | ✅ 必要 (Stripe からの非同期イベント受信を検証) |

### 3.1 共通フロー (Webhook 不要、§4)

検証環境にアクセスしてブラウザ操作で実施。Stripe Webhook の設定不要。

### 3.2 Webhook 系 (§5)

`/api/stripe/webhook` への配信を Stripe Dashboard で登録した上で実施。後述の手順で都度設定する。

---

## 4. 共通フロー (TC-1, 2, 3, 6, 7, 8, 9, 10)

### 4.1 事前準備 (共通)

1. 検証環境にアクセス: `https://deploy-preview-NNN--tasukiba.netlify.app` 等
2. 検証用 admin ユーザでログイン
   - 組織 ID / メール / パスワードは Supabase staging project の seed 値を使用
3. テストテナントを「Beginner プラン」で開設 (TC-1〜TC-3 で必要) または既存テナントを利用

### 4.2 TC-1: Beginner → Pro アップグレード (正常系)

**目的**: カード払いへの切替が正常に動作することを確認

**手順**:
1. テナント admin で `/settings/tenant/billing` を開く
2. 「Pro プランへアップグレード」をクリック → Stripe Checkout 画面に遷移
3. カード番号 `4242 4242 4242 4242` + 任意の他項目を入力 → 完了

**期待結果**:
- `/settings/tenant/billing` に戻り「Pro プラン (有効)」表示
- DB 上の `tenant.plan = 'pro'` / `tenant.stripeSubscriptionId = 'sub_*'` (Supabase Dashboard で確認)
- `auth_event_logs` テーブルに `plan_change` イベント 1 件 + tenantId 記録
- Stripe Dashboard (Test mode) で Customer + Subscription が作成済

### 4.3 TC-2: カード拒否 (decline)

**目的**: カード拒否時に DB 副作用が出ないことを確認

**手順**:
1. 手順は TC-1 と同じ
2. カード番号 `4000 0000 0000 0002` を入力 → 完了

**期待結果**:
- Stripe Checkout 画面で「Your card was declined」エラー表示
- キャンセル後 `/settings/tenant/billing` に戻る → `tenant.plan = 'beginner'` のまま
- DB 上で subscription レコード未作成 (= rollback 不要)

### 4.4 TC-3: 3D Secure 認証

**目的**: 3DS 認証チャレンジを通過して正常完了することを確認

**手順**:
1. TC-1 と同じ手順
2. カード番号 `4000 0027 6000 3184` 入力 → 3DS チャレンジ画面で `Complete authentication`

**期待結果**: TC-1 と同じ正常完了

### 4.5 TC-6: 課金 invariant (★最重要★)

**目的**: 課金額の 4 経路一致 (severity-1 リグレッション防止)

**手順**:
1. TC-1 完了後、`/admin/super/billing` を super_admin でログインして開く
2. 当該テナントの月次課金額を確認

**期待結果**:
- **ApiCallLog SUM (真値) = 画面表示額 = Stripe Invoice 金額 = CSV エクスポート額** の 4 経路一致

> **重要**: 不一致なら severity-1 (= [feedback_billing_invariant.md](../../CLAUDE.md) 違反)。即時修正対応が必要。

### 4.6 TC-7: サブスクリプション キャンセル

**目的**: 解約時の plan / subscription 状態確認

**手順**:
1. テナント admin で「プランを解約」操作

**期待結果**:
- Stripe Subscription の `cancel_at_period_end = true`
- `tenant.plan` は **そのまま維持** (Beginner に戻らない、[tenant-self.service.ts:432](../../src/services/tenant-self.service.ts#L432) の `BEGINNER_DOWNGRADE_FORBIDDEN` ガードが動作)
- 90日 expiry の新規発火なし (= 上位プラン経験済の `beginnerEverUpgraded = true`)

### 4.7 TC-8: ADR-0016 統合: 同 email で複数テナント Pro 払い出し

**目的**: multi-tenant 設計で同一個人が複数テナントを別 Stripe Customer として持てることを確認

> ⚠️ **PR #425 (2026-05-22) 時点: 未実施**
>
> 理由: staging 環境に super_admin ユーザが seed されておらず、新規組織払い出し操作ができないため。
> 本 PR の修正は paymentMethod 切替系のみで multi-tenant 分離ロジックには触れていない (= 構造的に回帰リスクなし)。
> 「同 email 別組織は別 Stripe Customer」は以下のコードレベルで既に保証:
> - `createOrGetStripeCustomer(tenantId)` がテナント単位で Customer 作成 ([stripe-billing.service.ts:57](../../src/services/stripe-billing.service.ts#L57))
> - `Tenant.stripeCustomerId` がテナント単位で独立保持 (schema)
> - Webhook 逆引きが `metadata.tenantId` で一意 (stripe-webhook-handlers.service.ts)
> - テナント越境テスト `tenant-isolation-invariants.test.ts` で全 list 系 service が tenantId フィルタ強制
>
> **将来の super_admin E2E 整備 PR で必ず実機実施**。それまで本 TC は「コード保証 + 実機未実施」状態。

**手順**:
1. ユーザ X が テナント A (Pro) 利用中
2. 同 email で別組織 テナント B を Pro で新規払い出し (super_admin 経由)
3. テナント B の billing setup で `4242 4242 4242 4242` 入力

**期待結果**:
- 両テナント別の Stripe Customer ID が作成される (= テナント別課金)
- 同 email でも別請求書が発行される

### 4.8 TC-9: ADR-0016 Revised (2026-05-22): 3 層 eligibility 判定

**目的**: 3 層判定 (層 1 = 自前テナント保有 / 層 2 = 招待 or Default 所属 / 層 3 = 完全新規) が UI / サーバ層の両方で動作することを確認

**判定キー**: `initialAdminEmail` のみ (= 「初期管理者メール」フィールド)。`billingContactEmail` は判定対象外 (= 共有 billing email の false positive を抑止)。

#### TC-9-a 層 1: 自前テナント保有ユーザ (= 公開フォーム完全不可)

**手順**:
1. テナント A の初期 admin (`tenants.created_by_user_id` に紐付く user) が email = X
2. `/signup` で `initialAdminEmail = X` を入力

**期待結果 (UI)**:
- `/api/auth/check-tenant-eligibility` が `{ signupAllowed: false, beginnerAvailable: false, reason: 'owned' }` を返す
- フォーム全体に「自前テナント保有」警告 + Discord 問合せリンク (`data-testid="owned-tenant-warning"`)
- submit ボタン disable

**期待結果 (サーバ = UI bypass)**:
- `plan=expert` でも `plan=pro` でも `plan=beginner` でも、すべて 409 `OWNED_TENANT_EXISTS` で reject

#### TC-9-b 層 2: 招待 / Default 所属のみ (= Beginner 不可、Expert/Pro 可)

**手順**:
1. ユーザ Y は Default テナント所属 (or 他テナントに招待された member)、ただしテナントを払い出した履歴なし
2. `/signup` で `initialAdminEmail = Y.email` を入力

**期待結果 (UI)**:
- `/api/auth/check-tenant-eligibility` が `{ signupAllowed: true, beginnerAvailable: false, reason: 'past_email_found' }` を返す
- Beginner radio disable + 「Expert または Pro をご選択ください」ヒント (`data-testid="beginner-unavailable-hint"`)
- Beginner 選択中なら自動で Expert に切替

**期待結果 (サーバ)**:
- `plan=beginner` で POST → 409 `BEGINNER_REQUIRES_UPGRADE`
- `plan=expert` or `plan=pro` で POST → 201 (正常払い出し + Stripe subscription 作成)

#### TC-9-c 層 3: 完全な新規 email (= 全プラン可)

**手順**:
1. `/signup` で `initialAdminEmail` に完全に新規な email を入力

**期待結果**:
- `/api/auth/check-tenant-eligibility` が `{ signupAllowed: true, beginnerAvailable: true, reason: 'none' }` を返す
- Beginner / Expert / Pro いずれも選択可
- 任意のプランで submit → 201 正常払い出し

#### TC-9-d super_admin による手動払い出し (SA-2)

**手順**:
1. 層 1 該当 email (= 自前テナント保有ユーザ) で `/admin/super/tenants/new` から払い出しを試行

**期待結果**:
- 3 層判定スキップ (= `skipEligibilityCheck=true`) で plan 自由選択 + 払い出し成功
- 「1 ユーザが複数の自前テナント保有」を super_admin 判断で許容する経路

> 関連: [ADR-0016 Revised section](../adr/0016-multi-tenant-user-membership.md#revised-2026-05-22) / [TENANT_AND_BILLING.md §34.14.5b](../business/TENANT_AND_BILLING.md)

### 4.9 TC-10: 90日 expiry 後の write 制限

**目的**: Beginner 90日経過後の read-only モードで import 等の write 系が遮断されることを確認

> ⚠️ **PR #425 (2026-05-22) 時点: 未実施**
>
> 理由: 本 PR の修正範囲は paymentMethod 切替系のみで Beginner 90日 expiry ロジック
> (`getBeginnerExpiryState` / middleware の write block) には触れておらず、回帰リスクなし。
> 検証には現役 Pro テナントを一時的に Beginner にバックデートする操作が必要で、
> 検証後に Pro へ戻す手間と DB 整合性リスクが大きい。
>
> **コード保証**:
> - `src/services/tenant-self.service.ts`: `getBeginnerExpiryState(plan, createdAt, beginnerEverUpgraded)` で 4 状態判定 (active / warning_60 / warning_75 / expired)
> - `src/middleware.ts`: expired 状態のテナントから write 系 HTTP method (POST/PATCH/PUT/DELETE) を弾く
> - `src/services/tenant-self.service.test.ts`: 上記ロジックを単体テストで保証
>
> **将来の super_admin E2E 整備 PR で必ず実機実施**。それまで本 TC は「コード保証 + 実機未実施」状態。

**手順**:
1. テナント A (Beginner) で 90日経過状態を再現 (Supabase Dashboard で `tenant.createdAt` を 91 日前にバックデート)
2. `POST /api/tenants/me/import` で任意 ZIP を送信試行

**期待結果**:
- middleware が 403 で弾く (Beginner read-only モード)
- export のみ可能 = データ救出経路は確保

---

## 5. Webhook 系 (TC-4, TC-5)

> ⚠️ **PR #425 (2026-05-22) 時点: 未実施**
>
> 理由: 本 PR の修正範囲は paymentMethod 切替系のみで Webhook handler
> (`stripe-webhook-handlers.service.ts`, `/api/webhooks/stripe/route.ts`) には触れておらず、
> 回帰リスクなし。staging で Webhook endpoint 設定 + `STRIPE_WEBHOOK_SECRET` 連携 + Stripe CLI
> セットアップが必要で、検証後の片付け工数も大きい。
>
> **コード保証**:
> - `src/services/stripe-webhook-handlers.service.ts`: 11 イベント (invoice.payment_failed,
>   customer.subscription.updated/deleted, payment_method.attached/detached, charge.succeeded 等)
>   の handler 実装済
> - `src/services/stripe-webhook-handlers.service.test.ts`: 各 handler のユニットテストで動作保証
> - `src/app/api/webhooks/stripe/route.ts`: 署名検証 + 冪等性 (= 同一 event_id 二重処理防止) + dispatch
>
> **将来の super_admin E2E 整備 PR で必ず実機実施**。それまで本 TC は「コード保証 + 実機未実施」状態。

> ## ⚠️ 本セクションは **TC-4 / TC-5 を実施する PR でのみ必要**
>
> Stripe からの非同期イベント受信を検証するテストです。**通常 PR (TC-4, 5 を実施しない場合) では §5 全体をスキップして構いません**。
>
> ### 通常 PR と Webhook PR の手順比較
>
> | 手順 | 通常 PR (TC-4, 5 なし) | Webhook PR (TC-4, 5 あり) |
> |---|---|---|
> | 1. 開発 + ローカル検証 | ✅ 共通 | ✅ 共通 |
> | 2. PR 作成 → Deploy Preview build | ✅ 共通 (自動) | ✅ 共通 (自動) |
> | **2-extra. Deploy Preview URL を Stripe Dashboard に Webhook endpoint 登録** | ❌ 不要 | ✅ **追加で必要** (§5.1 Step 2) |
> | **2-extra. STRIPE_WEBHOOK_SECRET を Deploy Preview context に上書き + redeploy** | ❌ 不要 | ✅ **追加で必要** (§5.1 Step 3) |
> | 3. ステージング動作確認 | ✅ TC-1, 2, 3, 6, 7, 8, 9, 10 | ✅ 通常分 + TC-4, 5 |
> | **3-extra. テスト完了後の掃除 (endpoint 削除 + WEBHOOK_SECRET 戻し)** | ❌ 不要 | ✅ **追加で必要** (§5.1 Step 4) |
> | 4. main merge | ✅ 共通 | ✅ 共通 |
>
> → **Webhook PR では §5.1 の 4 ステップ (Step 1-4) を追加実施** することで、PR ごとに変動する Deploy Preview URL の制約に対応する。

共通フローと違い、**Stripe Dashboard で Webhook endpoint を都度登録** する必要がある。

### 5.1 事前準備 (Webhook 系 共通)

#### Step 1: 検証環境の URL を確認

Deploy Preview の場合: `https://deploy-preview-NNN--tasukiba.netlify.app`
Branch Deploy の場合: `https://<branch-name>--tasukiba.netlify.app`

#### Step 2: Stripe Dashboard で Webhook endpoint を追加

1. Stripe Dashboard (Test mode 必須) → **Developers → Webhooks** → `Add endpoint`
2. **Endpoint URL**:
   ```
   https://<検証環境 URL>/api/stripe/webhook
   ```
   例: `https://deploy-preview-419--tasukiba.netlify.app/api/stripe/webhook`
3. **イベント選択**: 以下を購読 (= [STRIPE_SETUP.md §4.2](../operations/STRIPE_SETUP.md) の本番購読セットと同じ)
   - `checkout.session.completed`
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
   - `invoice.payment_succeeded`
   - `invoice.payment_failed`
   - 他、本番購読リストに準拠
4. `Add endpoint` で保存

#### Step 3: Signing secret を取得

1. 作成した endpoint の詳細ページで **`Signing secret`** をコピー (`whsec_...`)
2. Netlify Admin → Site configuration → Environment variables の `STRIPE_WEBHOOK_SECRET` を **Deploy Preview context** (or Branch Deploy context) で更新
3. **Redeploy** が必要 (= env vars 変更を反映するため Netlify Admin から手動 Trigger deploy)

#### Step 4: テスト終了後の掃除 (= TC-4, 5 完了後に必ず実施)

TC-4, 5 完了後、以下の **2 種類の掃除** を実施する。怠ると次回 Webhook PR で混乱の元になる。

##### 4-a. Stripe Dashboard で endpoint を削除

1. Stripe Dashboard → **Developers → Webhooks**
2. Step 2 で作成した PR 専用 endpoint (`deploy-preview-NNN--...`) を選択
3. 右上の `...` メニュー → **`Delete endpoint`**

削除しないと以下の問題が起きる:
- PR が close されると Deploy Preview URL は無効化される → Stripe が send-retry で webhook を投げ続けて失敗
- Stripe Dashboard が「配信失敗」アラートまみれになる
- 不要 endpoint が蓄積し月次レポートが汚染される

##### 4-b. Netlify env vars の STRIPE_WEBHOOK_SECRET を Deploy Preview context で **空 or 本番値に戻す**

1. Netlify Admin → Site configuration → Environment variables → `STRIPE_WEBHOOK_SECRET`
2. **Deploy Preview context** の値を本番と同じ secret に戻す (or `Use the same value as production` を選択)
3. Save

理由: 削除した endpoint の signing secret が残っていると、次回 別 PR で TC-4, 5 を実施するとき に古い secret で署名検証エラーになる。

### 5.2 TC-4: Webhook 検証 (succeeded + 冪等性)

**目的**: Webhook 受信処理が正しく動作 + 同一イベントの重複処理を防ぐ (idempotency)

**手順**:
1. §5.1 の事前準備を完了
2. §4.2 (TC-1: 正常系アップグレード) を実施
3. Stripe Dashboard → Webhooks → 作成した endpoint の `Recent deliveries` で配信状況を確認

**期待結果**:
- `checkout.session.completed` + `customer.subscription.created` が webhook に到達 (status 200)
- DB の `stripe_webhook_events` テーブルに 2 件記録 (= 受信ログ)
- 同 webhook イベントを Stripe Dashboard で「Resend」しても重複処理されない (= `eventId` で deduplication)

**冪等性の確認方法**:
1. Stripe Dashboard → Webhooks → 過去の successful delivery を選択
2. `Resend` ボタンをクリック (同じ event を再送)
3. DB 上で `tenant.plan` が変化していないこと、`stripe_webhook_events` に重複行が増えていないことを確認

### 5.3 TC-5: Webhook 検証 (payment_failed → DLQ)

**目的**: 課金失敗時に Dead Letter Queue (DLQ) に記録され、手動再投入が可能なことを確認

**手順**:
1. §5.1 の事前準備を完了
2. `4000 0000 0000 0341` で §4.2 (TC-1) を実施 (= 添付成功 / 課金拒否カード)
3. Stripe Test mode は初回課金時に自動で `invoice.payment_failed` を発火

**期待結果**:
- `/api/stripe/webhook` で処理失敗 → `stripe_webhook_dlq` テーブルに記録
- super_admin で `/admin/super/stripe-dlq` ページを開くと当該イベントが表示される
- 「再投入」ボタンで再実行可能

---

## 6. テスト実行チェックリスト

PR ごとにこのリストを使って完了確認:

### 共通フロー (Webhook 不要)
- [ ] TC-1: Pro アップグレード正常系
- [ ] TC-2: カード拒否
- [ ] TC-3: 3DS 認証
- [ ] TC-6: 課金 invariant (★最重要★)
- [ ] TC-7: サブスクリプション キャンセル
- [ ] TC-8: 同 email で複数テナント Pro 払い出し
- [ ] TC-9: P-B 強化 (既登録 → Pro 誘導)
- [ ] TC-10: 90日 expiry 後の write 制限

### Webhook 系 (要 Webhook endpoint 登録)
- [ ] §5.1 事前準備 (Stripe Dashboard で webhook endpoint 追加 + Signing secret 更新 + redeploy)
- [ ] TC-4: Webhook 検証 (succeeded + 冪等性)
- [ ] TC-5: Webhook 検証 (payment_failed → DLQ)
- [ ] §5.1 Step 4: テスト完了後の Stripe webhook endpoint 削除

---

## 7. トラブルシューティング

| 症状 | 原因候補 | 対処 |
|---|---|---|
| Stripe Checkout で「設定不備」エラー | env vars 未設定 / sk_live と sk_test の混在 | `STRIPE_SECRET_KEY` 等が Test mode のキーになっているか確認 |
| Webhook が `Recent deliveries` に出ない | endpoint URL の typo / Netlify env 未反映 | endpoint URL の `/api/stripe/webhook` を再確認 + redeploy |
| Webhook 配信は来るが 401 で fail | `STRIPE_WEBHOOK_SECRET` 不一致 | Stripe Dashboard の Signing secret と Netlify env を一致させる |
| `tenant.plan` が 'pro' に変わらない | Subscription 作成失敗 / DB 接続エラー | Netlify Function logs を確認 (Netlify Admin → Functions → `/api/...` のログ) |
| 課金 invariant 不一致 (TC-6) | severity-1 リグレッション | 即時開発チームエスカレーション、deploy を rollback ([ROLLBACK.md](../operations/ROLLBACK.md)) |

---

## 8. 関連ドキュメント

- [`docs/operations/STRIPE_SETUP.md`](../operations/STRIPE_SETUP.md) — Stripe Dashboard 設定 (Product / Meter / Webhook イベント一覧)
- [`docs/operations/STRIPE_WEBHOOK_EVENTS.md`](../operations/STRIPE_WEBHOOK_EVENTS.md) — Webhook イベント仕様
- [`docs/design/STRIPE_TECHNICAL_DESIGN.md`](../design/STRIPE_TECHNICAL_DESIGN.md) — Stripe 統合の設計判断
- [`docs/operations/DEPLOYMENT.md §3`](../operations/DEPLOYMENT.md#3-開発フロー-ローカル--ステージング--本番) — 検証環境 (Deploy Preview / Branch Deploy) の使い分け
- `feedback_billing_invariant.md` (CLAUDE.md memory) — 課金 invariant 規約 (★最重要)
