# Stripe Dashboard セットアップ手順 (super_admin 向け)

最終更新: 2026-05-19
関連: [STRIPE_BILLING.md](../business/STRIPE_BILLING.md) / [STRIPE_WEBHOOK_EVENTS.md](./STRIPE_WEBHOOK_EVENTS.md) / [ADR-0006](../adr/0006-stripe-metered-billing-integration.md)

本ドキュメントは、Stripe Metered Billing を導入する際に super_admin が **Stripe Dashboard 上で実施する事前セットアップ** をまとめたもの。本作業は実装 PR がマージされる前に完了させる必要がある (= 環境変数として Price ID / Webhook secret が必要なため)。

> **2026-05-19 改訂**: Sandbox 設定完了に伴い、実際の設定値・運用方針 (個人事業主 / Netlify / 8 回 retry / 期限超過保持) を反映。

---

## §1. Stripe アカウントの準備

### 1.1 アカウント作成 / ログイン
- Stripe Dashboard: https://dashboard.stripe.com/
- **個人事業主 OK** (= 法人必須ではない)。たすきば運営者は個人事業として登録
- **本人確認**: 身分証明 (= 個人事業主は運転免許/マイナンバーカード)、銀行口座情報、事業内容を提出 (= 数営業日〜1 週間)
- **必要な追加申請**:
  - クレジット取引セキュリティチェックリスト (= 割賦販売法準拠、12 項目)
  - 公開事業情報 (= 顧客サポート連絡先、ウェブサイト、特商法 URL)

### 1.2 環境分離 (Sandbox / Live mode)
- 2025+ の Stripe UI では「Sandbox」と呼ぶ (= 旧 Test mode)
- 上部のサンドボックスバナーで Sandbox / Live を切替
- 本作業は **Sandbox で先行構築 → 動作確認 → Live で同じ設定を再構築** する流れ (= 環境ごとに ID が完全に異なる)
- Sandbox の API キーは `sk_test_*` / `pk_test_*`、Live は `sk_live_*` / `pk_live_*`

---

## §2. Product と Meter / Price の作成

Dashboard → **商品カタログ** → **商品を追加**

> ⚠️ **2025+ の Stripe UI 仕様**: 従量課金 (Usage-based) には **Meter (= 使用量メーター) の事前作成が必須**。Meter 作成後に Price 作成画面で「料金モデル: 従量課金ベース」を選び、Meter を紐付ける。

### 2.1 Haiku per-call (Expert plan)

#### Meter 作成
| 項目 | 値 |
|---|---|
| 名前 | `たすきば Haiku per-call (Expert)` |
| イベント名 (event_name) | `tasukiba_haiku_api_call` |
| 集計方法 | 合計 (Sum) |

#### Price 作成
| 項目 | 値 |
|---|---|
| 商品名 | `たすきば Expert API Call (Haiku)` |
| 説明 | `Expert プランの API 呼び出し従量課金 (¥5/call、2026-05-15 改定: ¥10 → ¥5)` |
| **料金モデル** | **従量課金ベース** |
| 単価 | **`¥5` per unit** |
| 通貨 | JPY |
| 請求期間 | 月次 |
| メーター | (上記で作成した meter を選択) |
| 検索キー (lookup_key) | `haiku_per_call_expert` |
| 税の挙動 | **税抜** (Exclusive、Stripe Tax 未使用時もこれ) |

→ 環境変数 `STRIPE_PRICE_HAIKU` に Price ID (`price_1TYdtQK3TUQWW2eqIaBdikoV` 形式) を保存

### 2.2 Sonnet per-call (Pro plan)

#### Meter 作成
| 項目 | 値 |
|---|---|
| 名前 | `たすきば Sonnet per-call (Pro)` |
| イベント名 | `tasukiba_sonnet_api_call` |
| 集計方法 | 合計 (Sum) |

#### Price 作成
| 項目 | 値 |
|---|---|
| 商品名 | `たすきば Pro API Call (Sonnet)` |
| 説明 | `Pro プランの API 呼び出し従量課金 (¥15/call、2026-05-15 改定: ¥30 → ¥15)` |
| 料金モデル | 従量課金ベース |
| 単価 | **`¥15` per unit** |
| 請求期間 | 月次 |
| 検索キー | `sonnet_per_call_pro` |

→ 環境変数 `STRIPE_PRICE_SONNET` に保存

### 2.3 Storage Add-on (Plus)

> 定額プランのため Meter 不要。「その他の料金体系オプション」→ 定額制を選択。

| 項目 | 値 |
|---|---|
| 商品名 | `たすきば Storage Add-on (Plus)` |
| 説明 | `Storage Plus プラン (¥500/月、追加 100MB)` |
| 料金モデル | **定額制** (= 月次固定) |
| 単価 | `¥500` |
| 請求期間 | 月次 |
| 検索キー | `storage_plus` |

→ 環境変数 `STRIPE_PRICE_STORAGE_PLUS` に保存

### 2.4 Storage Add-on (Pro)

| 項目 | 値 |
|---|---|
| 商品名 | `たすきば Storage Add-on (Pro)` |
| 説明 | `Storage Pro プラン (¥1,500/月、追加 1GB)` |
| 料金モデル | 定額制 |
| 単価 | `¥1,500` |
| 請求期間 | 月次 |
| 検索キー | `storage_pro` |

→ 環境変数 `STRIPE_PRICE_STORAGE_PRO` に保存

---

## §3. Stripe Tax (任意 - 現時点はスキップ)

> **2026-05-19 現在**: たすきば運営者は個人事業主 + **適格請求書発行事業者として登録しない方針** ([tasukiba-user.md FAQ Q7](https://teppei19980914.github.io/HomePage/ja/product/tasukiba-user/#operator-info))。Stripe Tax は **スキップ可**。
>
> Live mode 切替時、もし将来 課税事業者 / インボイス登録に切り替える場合は本セクションを再実施。

### 3.1 (再開時) 基本設定
- Dashboard → **税金** → **Stripe Tax を有効化**
- 事業所所在地を入力
- JCT 登録番号 (`T1234567890123` 13 桁) を入力

### 3.2 (再開時) 商品ごとの Tax Code 設定
- 各 Product に `txcd_10000000` (Digital services - SaaS) を設定
- 日本国内顧客には 10% 消費税が自動加算される

---

## §4. Webhook エンドポイント設定

> **クレジットカード払いの動作確認 (TC-1〜TC-10) を実施する場合は [`docs/test/STRIPE_PAYMENT_TEST_PROCEDURE.md`](../test/STRIPE_PAYMENT_TEST_PROCEDURE.md) を参照。本セクションは本番運用向けの Webhook 設定であり、Deploy Preview / Branch Deploy での検証用 Webhook は別途登録する。**

Dashboard → **開発者** → **Webhook** → **送信先を追加**

### 4.1 エンドポイント情報

| 項目 | 値 |
|---|---|
| 送信先名 | `tasukiba-sandbox-webhook` (Sandbox) / `tasukiba-production-webhook` (Live) |
| エンドポイント URL | **Sandbox / Live 共通**: `https://tasukiba.netlify.app/api/webhooks/stripe`<br>(Live mode 用ドメインが分かれる場合はそれに合わせる) |
| API バージョン | **`2026-04-22.dahlia`** (2026-05-19 時点で Sandbox 新規アカウントの最新版) |
| 説明 | `たすきば Webhook (Sandbox / Live)` |

> ✅ **PR-V8 (2026-05-19) で対応完了**: コード側 (`src/lib/stripe.ts`) も `STRIPE_API_VERSION = '2026-04-22.dahlia'` に更新済 + Usage Record 送信は `billing.meterEvents.create` (= Meter API) に移行済 (`src/services/stripe-billing.service.ts reportUsage`)。
> Stripe Dashboard 側の Webhook 設定 API バージョン とコード側 API バージョンが一致 (Sandbox / Live ともに `2026-04-22.dahlia`)。

### 4.2 購読イベント (= 11 件)

詳細は [STRIPE_WEBHOOK_EVENTS.md](./STRIPE_WEBHOOK_EVENTS.md) を参照。Stripe Dashboard で以下 11 件にチェック:

| # | カテゴリ | イベント名 |
|---|---|---|
| 1 | Customer | `customer.updated` |
| 2 | Subscription | `customer.subscription.created` |
| 3 | Subscription | `customer.subscription.updated` |
| 4 | Subscription | `customer.subscription.deleted` |
| 5 | Invoice | `invoice.created` |
| 6 | Invoice | `invoice.finalized` |
| 7 | Invoice | `invoice.paid` |
| 8 | Invoice | `invoice.payment_failed` |
| 9 | PaymentMethod | `payment_method.attached` |
| 10 | PaymentMethod | `payment_method.detached` |
| 11 | PaymentMethod | `payment_method.updated` |

### 4.3 Signing secret の取得
- エンドポイント作成後、詳細画面の **署名シークレット** (= `whsec_xxxxx`) をコピー
- 環境変数 `STRIPE_WEBHOOK_SECRET` に保存
- ⚠️ **Sandbox と Live で別の secret** → 環境ごとに正しい値を Netlify に設定
- ⚠️ **シークレットの取り扱い**: チャット / メール / Slack 等で平文共有禁止。Netlify Dashboard に直接ペースト

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

Dashboard → **設定** → **Billing** → **カスタマーポータル**

### 6.1 セクション ON/OFF

| セクション | 設定 | 理由 |
|---|---|---|
| 次世代のポータル体験 | **OFF** (= 安定版を使用) | 仕様変更リスク回避 |
| 請求書の履歴 | **ON** | 顧客が過去請求書 PDF をダウンロード可能 |
| 顧客情報 (名前 / メール / 請求先住所 / 電話) | **ON** | 配送先住所と納税者番号は OFF |
| 決済手段 | **ON** | 顧客がカード追加・削除・既定切替可能 |
| **キャンセル** | **OFF** | サブスク解約はたすきば `/settings/tenant` セルフ解約フローに集約 (= Stripe と DB の整合性維持) |
| **プラン切替** | **OFF** | 同上 (= プラン変更はたすきば UI 経由のみ) |
| **数量変更** | **OFF** | 同上 |

### 6.2 ビジネス情報

| 項目 | 値 |
|---|---|
| ポータルのヘッダー | (任意。Sandbox: デフォルト "tasukiba サンドボックスは Stripe を使用しています"、Live: 「たすきば」推奨) |
| リダイレクトリンク | (任意。`https://tasukiba.netlify.app/settings/tenant` を設定すると UX 向上) |
| リーガルポリシー (利用規約 / プライバシーポリシー) | **「公開事業情報」画面 (§7) で設定した値を参照** |

---

## §7. Public business info (公開事業情報) の設定

Dashboard → **設定** → **ビジネス** → **ビジネスの詳細** → **公開情報** → **顧客サポート情報「編集する」**

### 7.1 必須項目 (= Customer Portal リーガル URL の参照元)

| 項目 | 値 |
|---|---|
| 利用規約 URL | `https://teppei19980914.github.io/HomePage/ja/product/tasukiba-user/#terms` |
| プライバシーポリシー URL | `https://teppei19980914.github.io/HomePage/ja/product/tasukiba-user/#privacy` |
| 特定商取引法に基づく表記 URL | `https://teppei19980914.github.io/HomePage/ja/product/tasukiba-user/#tokushoho` |

> **LP アンカー**: 利用規約・プライバシーポリシー・特定商取引法に基づく表記の本文は、HomePage リポジトリの `src/content/product/ja/tasukiba-user.md` の `#terms` / `#privacy` / `#tokushoho` セクションに集約されています (2026-05-21 / feat/legal-pages-lp-integration)。

### 7.2 Live mode 切替前の追加対応

Sandbox では Stripe placeholder のテストデータが入っている項目を、**Live 申請前に実値に置換**:
- サポート部門の住所 (= 実事業所住所、日本)
- サポート部門の電話番号 (= 実電話番号)
- 顧客サポートのメール (= 実メールアドレス)
- ビジネスのウェブサイト (= `https://tasukiba.netlify.app/`)

---

## §8. Smart Retries / メール通知設定

Dashboard → **設定** → **Billing** → **サブスクリプションとメール通知**

### 8.1 メール通知と顧客管理

#### 送信メール
| 項目 | 設定 | 理由 |
|---|---|---|
| トライアル期間終了 7 日前 | **OFF** | たすきば 90 日トライアルは Stripe 管理外 |
| 次回の更新 | **OFF** | たすきば請求書が一次通知 |
| 有効期限が近いカード | **ON** | プロアクティブ通知で失敗予防 |
| カード決済が失敗 | **ON** | 即時通知で支払い回復率向上 |
| 口座振替が失敗 | **OFF** | 銀行振込/invoice は Stripe 管理外 |

#### 決済手段の更新
- **「Stripe 上のページにリンク」** を選択 (= Customer Portal に自動連携)

#### サブスクリプションの管理
- **「顧客がサブスクリプションを管理するリンクを含める」 ON**
- **「Stripe カスタマーポータルへのリンクを使用」** 選択

### 8.2 サブスクリプションの決済失敗を管理 (Smart Retries)

| 項目 | 値 | 理由 |
|---|---|---|
| カード決済 | **Smart Retries** | Stripe 機械学習で最適タイミング |
| リトライ期間 / 回数 | **2 週間 / 最大 8 回** | Stripe 推奨値 |
| ACH Direct Debit | **OFF** | 米国 ACH 未使用 |
| **サブスクリプションステータス** (全リトライ失敗時) | **「サブスクリプションを期限超過のままにする」** | ⭐ たすきば 90 日 graceful policy を維持。Stripe が day 14 でキャンセルすると DB と齟齬が発生するため |
| 請求書ステータス | 期限超過のままにする | 同上 |

### 8.3 確認が必要な決済を管理 (3D Secure)

| 項目 | 設定 | 理由 |
|---|---|---|
| 3D セキュアを有効化 | **ON** | 日本のカード決済で事実上必須化。チャージバック保護 |
| 顧客のメール (Stripe が確認リンクを送信) | **ON** | 3DS 認証ワンタップで完了 |
| 決済確定が未完了の場合のお知らせ | **ON** | 3日 / 5日 / 7日 のリマインダー |
| サブスクリプションステータス (15日経過時) | サブスクリプションを期限超過のままにする | たすきば flow と整合 |
| 請求書ステータス (15日経過時) | 請求書を現状のままにする | デフォルト |

### 8.4 顧客に送信された請求書を管理

| 項目 | 設定 |
|---|---|
| 確定済の請求書を顧客に送信 | **ON** |
| 継続的な請求書が未払いの場合のお知らせ | **ON** (= 期日当日リマインダー) |
| サブスク/請求書 60日経過時 | 期限超過のままにする (デフォルト) |

### 8.5 アプリ側の連携

- Stripe Smart Retries 中 → 個別の `invoice.payment_failed` Webhook で `BillingHistory.status = 'failed'` 記録
- `customer.subscription.updated` で `status: 'past_due'` 受信 → `tenant.autoSuspendScheduledAt = now + N 日`
- 日次 cron `stripe-auto-suspend` で suspend → 段階的に read-only → 90 日後 delete
- 全リトライ失敗後も Stripe サブスクは「期限超過」のまま残る → 顧客が Customer Portal でカード更新したら再課金可能

---

## §9. 環境変数まとめ (Netlify に登録)

完了後、Netlify Dashboard → Site → Site configuration → Environment variables に以下を登録:

### Stripe 関連 (8 件 + 1)

| 環境変数 | Sandbox 値 | Live 値 | 用途 |
|---|---|---|---|
| `STRIPE_ENABLED` | `false` (初期は false で安全側起動) → 動作確認後 `true` | `true` | feature flag |
| `STRIPE_SECRET_KEY` | `sk_test_xxxx` | `sk_live_xxxx` | サーバ側 Stripe SDK 認証 |
| `STRIPE_WEBHOOK_SECRET` | `whsec_xxxx` (Sandbox) | `whsec_xxxx` (Live) | Webhook 署名検証 |
| `STRIPE_PRICE_HAIKU` | `price_xxxx` (Sandbox) | `price_xxxx` (Live) | Haiku per-call の Price ID |
| `STRIPE_PRICE_SONNET` | `price_xxxx` (Sandbox) | `price_xxxx` (Live) | Sonnet per-call の Price ID |
| `STRIPE_PRICE_STORAGE_PLUS` | `price_xxxx` (Sandbox) | `price_xxxx` (Live) | Storage Plus の Price ID |
| `STRIPE_PRICE_STORAGE_PRO` | `price_xxxx` (Sandbox) | `price_xxxx` (Live) | Storage Pro の Price ID |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | `pk_test_xxxx` | `pk_live_xxxx` | フロントエンド用 (Checkout / Elements) |

### 既設定の確認 (= Stripe 統合に必要な前提)

| 環境変数 | 設定値の例 | 用途 |
|---|---|---|
| `SYSTEM_USER_ID` | `63cf718f-98cf-4882-9d6d-206441607d16` | Webhook の system actor (= 監査ログに記録) |
| `CRON_SECRET` | (ランダム値) | cron 認証 (`stripe-reconcile` 等で Bearer header) |
| `ADMIN_SUPER_BASIC_AUTH_USER` | (任意) | `/admin/super/*` Basic Auth (PR-V7 #7) |
| `ADMIN_SUPER_BASIC_AUTH_PASS` | (16 文字以上推奨) | 同上 |

### 注意事項
- `STRIPE_ENABLED=false` で起動すれば、コードはマージ済でも顧客には機能が見えない (= 段階的ロールアウト)
- `STRIPE_SECRET_KEY` の値 (sk_test / sk_live) で Stripe SDK が自動的に環境を判別 — 環境変数で完全に分離
- Netlify Branch deploy では Sandbox 用、本番 deploy では Live 用のキーを使い分け推奨

---

## §10. Sandbox での動作確認 (Phase 4)

`STRIPE_ENABLED=true` に切替後、以下を順次実施:

### 10.1 カード登録テスト
1. テスト用テナントで `/settings/tenant` を開く
2. 「クレジットカード払いに切替」を選択 → Stripe Checkout が開く
3. テストカード番号 `4242 4242 4242 4242` (= 成功) を入力 → 登録成功確認
4. DB の `tenant.stripeCustomerId`, `stripeDefaultPaymentMethodId` がセットされていることを確認
5. `payment_method.attached` Webhook 受信、`customer.subscription.created` Webhook 受信を確認

### 10.2 Usage Record 送信テスト (= PR-V8 後)
1. 切替テナントで API 呼び出しを実行 (= LLM 利用)
2. 5 分後に `StripeUsageRecordQueue` がクリアされ、Meter Events に反映されていることを確認
3. Stripe Dashboard → 商品 → Haiku → Meter で件数が反映されていることを確認

### 10.3 引落失敗テスト
1. テナントのカードを `4000 0000 0000 0341` (= 後続支払い時に失敗) に変更
2. Stripe Dashboard で当月分 Invoice を強制的に finalize (Manual invoicing)
3. Webhook `invoice.payment_failed` 受信を確認 → `BillingHistory.status = 'failed'` を確認
4. Smart Retries が 2 週間続くことを確認
5. 期間経過後、`subscription.updated` で `status: 'past_due'` → `autoSuspendScheduledAt` セットを確認

### 10.4 Webhook の冪等性確認
1. Stripe Dashboard で同じイベントを 2 回再送
2. `StripeWebhookEvent` テーブルに 1 行のみ (UNIQUE 違反で 2 回目はスキップ) を確認

### 10.5 cron 動作確認
- `/api/cron/stripe-usage-flush` (= 5 分間隔、Vercel Hobby 制約で日次に変更済)
- `/api/cron/stripe-auto-suspend` (= 日次 05:00 UTC)
- `/api/cron/stripe-reconcile` (= 月初 06:00 UTC、PR-V7 #5、Subscription + Amount 照合 PR-V7a B-2)
- `/api/cron/billing-monthly-aggregation` (= 月初 2 日 00:00 UTC、PR-V7a B-1: invoice 月次集計)
- `/api/cron/billing-overdue-alert` (= 日次 08:00 UTC、PR-V7a B-3: 期日超過督促)
- `/api/cron/cron-failure-alert` (= 日次 09:00 UTC、PR-V7a B-4: cron 失敗集約通知)
- cron-job.org で実行履歴を確認

---

## §11. Live mode 移行チェックリスト (Phase 5)

Sandbox 動作確認 OK 後、Live mode で同じ設定を再構築:

### 必須
- [ ] Stripe Live mode で本人確認完了 (個人事業主、身分証提出)
- [ ] クレジット取引セキュリティチェックリスト 1.1〜1.12 すべて「はい」
- [ ] 公開事業情報 placeholder データを実値に置換 (= サポート住所 / 電話 / メール / ウェブサイト)
- [ ] Live mode で Product / Meter / Price を再作成 (= ID が変わる)
- [ ] Live mode で Webhook エンドポイント追加 + 11 イベント購読
- [ ] Live mode の Customer Portal を Sandbox と同じ設定で構築
- [ ] Live mode の Smart Retries / メール通知設定を Sandbox と同じ値で構築
- [ ] Live API キー (`sk_live_xxxx`) + Webhook secret (`whsec_xxxx`) を Netlify Live 環境変数に登録 (= 平文共有禁止、Dashboard 直接入力)
- [ ] `STRIPE_PRICE_*` を Live mode の Price ID に置換 (= Sandbox Price ID と混同しないこと)
- [x] **PR-V8 完了**: コード側の API バージョン `2026-04-22.dahlia` + Meter API 対応完了 (= PR #411 にバンドル merge 済)
- [ ] 利用規約 / 特商法に Stripe 決済 / 自動更新条項が反映済
- [ ] LP `#tokushoho` アンカーが Live mode の特商法 URL に設定済

---

## §12. トラブルシューティング

| 症状 | 原因候補 | 対処 |
|---|---|---|
| Webhook が受信されない | URL 設定ミス / signature 検証失敗 | Stripe Dashboard → Webhooks → 該当エンドポイント → Event log で配信履歴確認 |
| Webhook が `400 Bad Request` で reject される | コード側 API バージョン不一致 | `src/lib/stripe.ts` の `STRIPE_API_VERSION` と Dashboard 側設定が一致するか確認 (= PR-V8 で `2026-04-22.dahlia` に統一済) |
| Usage Record (Meter Event) が反映されない | Meter event_name 不一致 / Stripe Customer ID 不在 | (1) `src/lib/stripe.ts` の `STRIPE_METER_EVENT_NAMES` (= `tasukiba_haiku_api_call` / `tasukiba_sonnet_api_call`) が Stripe Meter 側と完全一致するか<br/>(2) Tenant.stripeCustomerId が null でないか<br/>(3) Customer の active Subscription が当該 Meter の Price を含むか |
| 金額が顧客の見ているものと違う | Tax Code 設定漏れ / 税込/税抜の混同 | Stripe Tax 設定 + Price の Tax behavior を **税抜** に統一 (= Stripe Tax 未使用時もこれ) |
| 「期限超過」状態から復帰しない | カード更新後の retry 失敗 | 顧客に Customer Portal でカード再登録を依頼 / Dashboard で手動 retry |
| Sandbox でカードが拒否される | 本番カードを使用 | テスト用カード番号 `4242 4242 4242 4242` (= 成功) を使用 |
| `/admin/super/*` にアクセスすると 401 | Basic Auth 認証情報未入力 / 不一致 | Netlify 環境変数 `ADMIN_SUPER_BASIC_AUTH_USER` / `ADMIN_SUPER_BASIC_AUTH_PASS` を確認 (PR-V7 #7) |

詳細: [Stripe 公式 Troubleshooting](https://docs.stripe.com/billing/subscriptions/overview)

---

## 改訂履歴

| 日付 | 変更 | PR |
|---|---|---|
| 2026-05-19 (PR-V8) | Stripe API バージョンを `2024-12-18.acacia` → `2026-04-22.dahlia` に更新 + Usage Record 送信を `subscriptionItems.createUsageRecord` (legacy) → `billing.meterEvents.create` (Meter API) に移行 | PR #411 (バンドル) |
| 2026-05-19 (PR-V7a) | 請求業務横展開実装に伴う運用追加: invoice 手動消込 UI / 月次集計 cron / 期日超過 alert / cron 失敗 alert / 金額照合 / CSV エクスポート / 顧客向け請求金額表示 | PR #411 |
| 2026-05-19 | Sandbox 設定完了反映: 個人事業主対応 / Netlify 移行 / Meter UI 必須化 / Smart Retries 8回2週間/期限超過保持 / Customer Portal 12 項目 / Public business info / Stripe Tax スキップ | (docs PR) |
| 2026-05-14 | 初版策定 (v1.x Stripe 連携仕様確定に伴う) | docs/stripe-integration-spec |
