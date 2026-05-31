# Stripe Dashboard セットアップ手順 (super_admin 向け)

最終更新: 2026-05-19
関連: [STRIPE_BILLING.md](../../business/STRIPE_BILLING.md) / [STRIPE_WEBHOOK_EVENTS.md](../operate/STRIPE_WEBHOOK_EVENTS.md) / [ADR-0006](../../adr/0006-stripe-metered-billing-integration.md)

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
| 商品名 | `たすきば Expert プロジェクト作成/更新 (Haiku)` |
| 説明 | `Expert プランのプロジェクト作成/更新 1 回あたり ¥10 (ADR-0019 / 2026-05-24 改定: ¥5 → ¥10)` |
| **料金モデル** | **従量課金ベース** |
| 単価 | **`¥10` per unit** (ADR-0019 後) |
| 通貨 | JPY |
| 請求期間 | 月次 |
| メーター | (上記で作成した meter を選択) |
| 検索キー (lookup_key) | `haiku_per_call_expert_v2` (旧 `haiku_per_call_expert` は archive) |
| 税の挙動 | **税抜** (Exclusive、Stripe Tax 未使用時もこれ) |

→ 環境変数 `STRIPE_PRICE_HAIKU` に **新 Price ID** (`price_1TYdtQK3TUQWW2eqIaBdikoV` 形式) を保存。Netlify production / staging の両方で切替必要。旧 ¥5/call Price は **archive** (削除不可、archive のみ)。

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
| 商品名 | `たすきば Pro プロジェクト作成/更新 + なぜ?機能 (Sonnet)` |
| 説明 | `Pro プランのプロジェクト作成/更新 + なぜ?機能 1 回あたり ¥15 (据置、ADR-0019)` |
| 料金モデル | 従量課金ベース |
| 単価 | **`¥15` per unit** (据置、変更不要) |
| 請求期間 | 月次 |
| 検索キー | `sonnet_per_call_pro` |

→ 環境変数 `STRIPE_PRICE_SONNET` に保存。**ADR-0019 では Sonnet 単価変更なし**、既存 Price をそのまま使用可。

### 2.2-bis Embedding Price 作成 (ADR-0022 / 2026-06-01、ADR-0029 単価改定 / 2026-05-30)

> ✅ **2026-05-30 更新**: PR #469 で credit_card 払い UI が解禁され、**6/1 リリース時点で credit_card 払いを有効化** したため、本セクションの作業は **必須** です (= Embedding Subscription Item が credit_card テナントに紐付かないと Stripe Invoice に embedding 課金が反映されず、`feedback_billing_invariant` 違反となります)。
>
> Live mode 切替手順を完遂し、`STRIPE_PRICE_EMBEDDING` を Production に設定 → `createSubscriptionForTenant` が 5 本目の Subscription Item (Haiku/Sonnet/**Embedding**/DB容量/Storage) として自動追加します。

1. **新 Meter event 作成**:
   - 商品カタログ → メーター → 「新規メーター」
   - イベント名: `tasukiba_embedding_call` (= `STRIPE_METER_EVENT_NAMES.embedding` と完全一致必須)
   - 集計タイプ: 合計 (sum)
   - イベントペイロード キー: `stripe_customer_id` / `value`

2. **新 Embedding Price 作成** (ADR-0029 / 2026-05-30: ¥1 → ¥5 改定):

| 項目 | 値 |
|---|---|
| 商品名 | `たすきば Embedding 課金 (Expert / Pro)` (= 資産入力 / チャット検索 / CSV / 添付ファイル embedding) |
| 説明 | `Expert/Pro プランの Embedding 業務操作 1 回あたり ¥5 (ADR-0022 初版 ¥1 → ADR-0029 ¥5 改定)。Beginner は 0 課金 (= queue 不投入のため Subscription Item は不要)` |
| 料金モデル | 従量課金ベース (新規 Meter `tasukiba_embedding_call` に紐付け) |
| 単価 | **`¥5` per unit** ★ADR-0029 改定後★ |
| 請求期間 | 月次 |
| 検索キー | (任意) `embedding_per_call_v2` |

3. **環境変数設定**:
   - `STRIPE_PRICE_EMBEDDING` を staging (Sandbox) + production (Live) の両方に設定 (= Test / Live で別 Price ID)
   - Production 値は **Live mode Account ID (`KHIaXKbo0M`) が埋め込まれていること** を必ず目視確認 (Sandbox 値が混入すると Subscription 作成時に `No such price` 400 で `StripeInvalidRequestError` 発生、launch 直前の TC-L4 検証で発覚した罠)
   - 設定後、`createSubscriptionForTenant` は自動的に 5 本目の Subscription Item として追加 (= コード変更ゼロの Stripe-ready 設計)

4. **既存 credit_card テナントへの migrate** (本 docs 更新時点では Default テナントのみ):
   - Stripe Dashboard で既存 active Subscription の Items に Embedding Price を追加
   - またはテナント側で「銀行振込 → クレジットカード」再切替で新 Subscription を作成 (= 5 Item 構成で再生成)

### 2.3 ~~Storage Add-on (Plus)~~ — **ADR-0020 で廃止**

> **⚠️ ADR-0020 (2026-05-25)**: 4 段階 Storage Add-on プラン (Plus/Pro/Enterprise) は廃止され、
> §2.5 の DB 容量従量課金 (1 Meter のみ) に統一されました。
>
> 既存運用では: Stripe Dashboard で旧 Storage Add-on Product を **archive** し、
> 環境変数 `STRIPE_PRICE_STORAGE_PLUS` / `STRIPE_PRICE_STORAGE_PRO` は削除可。
> ただし launch 前のため、本番に既存契約者なし → 単に Product を archive するのみで OK。

### 2.4 ~~Storage Add-on (Pro)~~ — **ADR-0020 で廃止**

§2.3 と同じ。

### 2.5 DB 容量従量課金 (ADR-0020 / 2026-05-25)

> **ADR-0020 新規追加**: DB 容量を「使った分だけ」階段関数型で課金 (50MB 無料 + 1GB tier × ¥50)。
> 月中 peak ベースで請求する R6 案 A 設計のため、**Meter quantity 単位 = ¥1 (円整数)** で送信。
> これにより `ApiCallLog.costJpy = Stripe Meter quantity = 請求金額` の完全一致を保証。

#### Meter 作成

| 項目 | 値 |
|---|---|
| イベント名 (event_name) | `tasukiba_db_capacity_overage_jpy` |
| 表示名 | たすきば DB 容量超過 (円) |
| ペイロードキー | `value` (= 円整数を文字列で送信) |
| 集約方式 | sum |

#### Price 作成

| 項目 | 値 |
|---|---|
| 商品名 | `たすきば DB 容量超過 (従量課金)` |
| 説明 | `50MB 超過分を 1GB tier ごとに ¥50 で課金 (R6 案 A: quantity=円整数)` |
| 料金モデル | **従量課金ベース** (= Meter 連動) |
| Meter | `tasukiba_db_capacity_overage_jpy` (= §2.5 で作成) |
| **単価** | **¥1 / unit** (= quantity に円整数をそのまま送信) |
| 請求期間 | 月次 |
| 検索キー (lookup_key) | `db_capacity_overage_jpy` |

→ 環境変数 `STRIPE_PRICE_DB_CAPACITY_OVERAGE` に保存。

#### 動作確認

1. テナント設定で 50MB を超える DB 使用量を作る (例: テストインポートで 100MB 投入)
2. 月初 cron (`/api/cron/tenant-monthly-reset`) を手動実行
3. Stripe Dashboard → Meter Events で `tasukiba_db_capacity_overage_jpy` の event が記録されるか確認
4. 請求書プレビューで「DB 容量超過: ¥50」が計上されるか確認

#### 注意点

- **Meter quantity の最大値**: Stripe API は long を許容 (10^9+ 程度まで)。
  ハードキャップ 50GB 到達ユーザでも max ¥2,500 → 余裕で範囲内。
- **idempotency**: `identifier = usage:db_capacity_overage:{apiCallLogId}` で 24h 重複防止。
- **timestamp**: 前月末瞬間 (= 月跨ぎ瞬間) を送信、過去 35 日以内なので正常受領される。

#### Stripe Subscription Item 紐付け (2026-05-30 補完) ★credit_card 払いの請求 invariant に必須★

> **重要**: `STRIPE_PRICE_DB_CAPACITY_OVERAGE` 環境変数を設定するだけでは Stripe Meter Event の `tasukiba_db_capacity_overage_jpy` が **Stripe Invoice に反映されない**。Meter Event は Subscription Item に紐付かないと Invoice に乗らない Stripe 仕様のため、`createSubscriptionForTenant` が当該 Price を Item として追加する必要がある。

- **Stripe-ready optional 設計** ([src/services/stripe-billing.service.ts](../../../src/services/stripe-billing.service.ts) `createSubscriptionForTenant` / ADR-0022 Embedding と同パターン):
  - **`STRIPE_PRICE_DB_CAPACITY_OVERAGE` 未設定**: Subscription Item は追加されない (= Sandbox / 開発環境向け)。Stripe Meter Event は送信されるが、Stripe Invoice には反映されない。
  - **`STRIPE_PRICE_DB_CAPACITY_OVERAGE` 設定済 (= ✅ 2026-05-30 Production 設定済)**: 新規 Subscription 作成時に Item として追加 (Haiku + Sonnet + Embedding + DB 容量超過 + ファイルストレージ超過 = **5 本構成**)。これにより月初 cron が送信する Meter Event の円整数 quantity が当該 Item に集約され、Stripe Invoice に反映される。
- **invariant 担保**: invoice 払いの BillingHistory (= `BILLABLE_FEATURE_UNITS` の ApiCallLog SUM) と Stripe Invoice の金額が完全一致する設計。テナントダッシュボード表示 = 請求書 = Stripe Invoice の 5 点 invariant (6/1 launch から credit_card 経路稼働中)。
- **Webhook 同期**: `handleSubscriptionUpdated` で `stripeSubscriptionItemDbCapacityId` カラムも同期更新 (カード再登録などで Subscription が再作成されても DB と Stripe の Item ID が常に一致)。
- **Stripe-ready 設計を維持**: env 設定だけで動き出す設計のまま (詳細: [src/lib/stripe.ts](../../../src/lib/stripe.ts) `getStripePriceConfig` の `dbCapacityOverage?` フィールド)。Sandbox/開発環境への一時的な無効化も env 撤去だけで可能。

### 2.6 ファイルストレージ従量課金 (ADR-0021 / 2026-05-26)

> **ADR-0021 新規追加**: ファイル添付ストレージを「使った分だけ」階段関数型で課金 (100MB 無料 + 1GB tier × ¥10、50GB hardcap)。
> §2.5 と同設計 (= R6 案 A、Meter quantity = ¥1 で `ApiCallLog.costJpy = Stripe quantity = 請求金額` の完全一致)。

#### Meter 作成

| 項目 | 値 |
|---|---|
| イベント名 (event_name) | `tasukiba_storage_file_overage_jpy` |
| 表示名 | たすきば ファイルストレージ超過 (円) |
| ペイロードキー | `value` (= 円整数を文字列で送信) |
| 集約方式 | sum |

#### Price 作成

| 項目 | 値 |
|---|---|
| 商品名 | `たすきば ファイルストレージ超過 (従量課金)` |
| 説明 | `100MB 超過分を 1GB tier ごとに ¥10 で課金 (R6 案 A: quantity=円整数)` |
| 料金モデル | **従量課金ベース** (= Meter 連動) |
| Meter | `tasukiba_storage_file_overage_jpy` (= §2.6 で作成) |
| **単価** | **¥1 / unit** (= quantity に円整数をそのまま送信) |
| 請求期間 | 月次 |
| 検索キー (lookup_key) | `storage_file_overage_jpy` |

→ 環境変数 `STRIPE_PRICE_STORAGE_FILE_OVERAGE` に保存。

#### 動作確認

1. テナント設定で 100MB を超えるファイル添付を作る (例: 200MB の PDF を Pre-signed URL アップロード)
2. 月初 cron (`/api/cron/tenant-monthly-reset`) を手動実行
3. Stripe Dashboard → Meter Events で `tasukiba_storage_file_overage_jpy` の event が記録されるか確認
4. 請求書プレビューで「ファイルストレージ超過: ¥10」が計上されるか確認

#### 注意点

- **Meter quantity の最大値**: 50GB ハードキャップ到達ユーザでも max ¥500 → 余裕で範囲内。
- **idempotency**: `identifier = usage:storage_file_overage:{apiCallLogId}` で 24h 重複防止。
- **timestamp**: 前月末瞬間 (= 月跨ぎ瞬間) を送信、過去 35 日以内なので正常受領される。

#### Stripe Subscription Item 紐付け (2026-05-30 補完) ★credit_card 払いの請求 invariant に必須★

> **重要**: §2.5 と同設計。`STRIPE_PRICE_STORAGE_FILE_OVERAGE` 環境変数を設定するだけでは Stripe Invoice に反映されないため、`createSubscriptionForTenant` が当該 Price を Subscription Item として追加する必要がある。

- **Stripe-ready optional 設計**: `STRIPE_PRICE_STORAGE_FILE_OVERAGE` 設定時のみ Subscription Item として追加 (= 旧挙動互換)。
- **invariant 担保**: invoice 払いの BillingHistory と Stripe Invoice の金額が完全一致。
- **Webhook 同期**: `handleSubscriptionUpdated` で `stripeSubscriptionItemStorageFileId` カラムも同期更新。
- 詳細実装: [src/services/stripe-billing.service.ts](../../../src/services/stripe-billing.service.ts) `createSubscriptionForTenant` / [src/lib/stripe.ts](../../../src/lib/stripe.ts) `getStripePriceConfig` の `storageFileOverage?` フィールド。

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

> **クレジットカード払いの動作確認 (TC-1〜TC-10) を実施する場合は [`docs/test/STRIPE_PAYMENT_TEST_PROCEDURE.md`](../../test/STRIPE_PAYMENT_TEST_PROCEDURE.md) を参照。本セクションは本番運用向けの Webhook 設定であり、Deploy Preview / Branch Deploy での検証用 Webhook は別途登録する。**

Dashboard → **開発者** → **Webhook** → **送信先を追加**

### 4.1 エンドポイント情報

| 項目 | 値 |
|---|---|
| 送信先名 | `tasukiba-sandbox-webhook` (Sandbox) / `tasukiba-production-webhook` (Live) |
| エンドポイント URL | **Sandbox / Live 共通**: `https://tasukiba.com/api/webhooks/stripe`<br>(Live mode 用ドメインが分かれる場合はそれに合わせる) |
| API バージョン | **`2026-04-22.dahlia`** (2026-05-19 時点で Sandbox 新規アカウントの最新版) |
| 説明 | `たすきば Webhook (Sandbox / Live)` |

> ✅ **PR-V8 (2026-05-19) で対応完了**: コード側 (`src/lib/stripe.ts`) も `STRIPE_API_VERSION = '2026-04-22.dahlia'` に更新済 + Usage Record 送信は `billing.meterEvents.create` (= Meter API) に移行済 (`src/services/stripe-billing.service.ts reportUsage`)。
> Stripe Dashboard 側の Webhook 設定 API バージョン とコード側 API バージョンが一致 (Sandbox / Live ともに `2026-04-22.dahlia`)。

### 4.2 購読イベント (= 11 件)

詳細は [STRIPE_WEBHOOK_EVENTS.md](../operate/STRIPE_WEBHOOK_EVENTS.md) を参照。Stripe Dashboard で以下 11 件にチェック:

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
- ⚠️ **絶対に GitHub にコミットしない**。Netlify 環境変数 `STRIPE_SECRET_KEY` に直接登録
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
| リダイレクトリンク | (任意。`https://tasukiba.com/settings/tenant` を設定すると UX 向上) |
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
- ビジネスのウェブサイト (= `https://tasukiba.com/`)

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

### Stripe 関連 (基本 4 件 + Price 5 件)

> **2026-05-30 訂正**: 廃止済みの `STRIPE_PRICE_STORAGE_PLUS` / `STRIPE_PRICE_STORAGE_PRO` (ADR-0020 で 4 段階 Storage Add-on を廃止) を削除し、現行の **5 Item invariant** に合わせた。`STRIPE_PRICE_*` は **5 件** = Haiku / Sonnet / Embedding / DB 容量超過 / ファイルストレージ超過 で、これが `createSubscriptionForTenant` の 5 本構成の Subscription Item に対応する (真値は [`src/lib/stripe.ts`](../../../src/lib/stripe.ts) `getStripePriceConfig`)。

| 環境変数 | Sandbox 値 | Live 値 | 用途 |
|---|---|---|---|
| `STRIPE_ENABLED` | `false` (初期は false で安全側起動) → 動作確認後 `true` | `true` | feature flag |
| `STRIPE_SECRET_KEY` | `sk_test_xxxx` | `sk_live_xxxx` | サーバ側 Stripe SDK 認証 |
| `STRIPE_WEBHOOK_SECRET` | `whsec_xxxx` (Sandbox) | `whsec_xxxx` (Live) | Webhook 署名検証 |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | `pk_test_xxxx` | `pk_live_xxxx` | フロントエンド用 (Checkout / Elements) |
| `STRIPE_PRICE_HAIKU` | `price_xxxx` (Sandbox) | `price_xxxx` (Live) | Haiku per-call の Price ID (§2.1) |
| `STRIPE_PRICE_SONNET` | `price_xxxx` (Sandbox) | `price_xxxx` (Live) | Sonnet per-call の Price ID (§2.2) |
| `STRIPE_PRICE_EMBEDDING` | `price_xxxx` (Sandbox) | `price_xxxx` (Live) | Embedding per-call の Price ID (§2.2-bis、ADR-0022/0029) |
| `STRIPE_PRICE_DB_CAPACITY_OVERAGE` | `price_xxxx` (Sandbox) | `price_xxxx` (Live) | DB 容量超過の Price ID (§2.5、ADR-0020) |
| `STRIPE_PRICE_STORAGE_FILE_OVERAGE` | `price_xxxx` (Sandbox) | `price_xxxx` (Live) | ファイルストレージ超過の Price ID (§2.6、ADR-0021) |

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

**Stripe / 請求関連 cron (本ガイドの主対象)**:
- `/api/cron/stripe-usage-flush` (= 日次 05:00 UTC = JST 14:00、旧 Vercel Hobby 時代の cron 最小間隔制約の名残で日次運用継続中。Netlify + 外部 cron 構成では 1 分間隔まで設定可能)
- `/api/cron/stripe-auto-suspend` (= 日次 04:00 UTC = JST 13:00、引落失敗テナント suspend)
- `/api/cron/stripe-reconcile` (= 月初 06:00 UTC = JST 15:00、PR-V7 #5、Subscription + Amount 照合 PR-V7a B-2)
- `/api/cron/billing-monthly-aggregation` (= 毎月 2 日 00:00 UTC = JST 09:00、PR-V7a B-1: invoice 月次集計)
- `/api/cron/billing-overdue-alert` (= 日次 08:00 UTC = JST 17:00、PR-V7a B-3: 期日超過督促)
- `/api/cron/cron-failure-alert` (= 日次 09:00 UTC = JST 18:00、PR-V7a B-4: cron 失敗集約通知、他 cron 完走後)

**周辺 cron (運用全体を把握するため列挙、詳細は [CRON.md](../operate/CRON.md))**:
- `/api/cron/tenant-monthly-reset` (= 毎月 1 日 00:00 UTC = JST 09:00、月次カウンタリセット + 月初 embedding backfill)
- `/api/cron/daily-usage-aggregation` (= 日次 02:00 UTC = JST 11:00、使用量集計 + Beginner 期限警告)
- `/api/cron/daily-notifications` (= 日次 22:00 UTC = JST 翌日 07:00、ACT リマインダ + DB/Storage drift 検知)
- `/api/cron/diagnostics-daily-alert` (= 日次 02:30 UTC = JST 11:30、診断ダッシュボード異常を朝に push)
- `/api/cron/attachment-embedding` (= 10 分間隔、ADR-0021 ファイル添付の embedding queue 処理)

cron-job.org で実行履歴を確認 (詳細手順は [CRON.md §8〜§9](../operate/CRON.md) 参照)。

> 🆕 **2026-05-29 反映**: 本一覧は cron-job.org 実態と完全照合済 (旧 `stripe-auto-suspend` の 05:00 UTC 誤記を 04:00 UTC に訂正、周辺 cron 5 件を補完)。

---

## §11. Live mode 移行チェックリスト (Phase 5) — ✅ 2026-05-30 完了

> ✅ **2026-05-30 完了**: 6/1 リリース前検証セッション (TC-L1〜L8) で Sandbox → Live 移行を完遂しました。
> 5 Subscription Item (Haiku / Sonnet / Embedding / DB 容量 / Storage) invariant 担保 + Webhook 配送疎通 + 解約フロー全て確認済み。

### 完了項目
- [x] Stripe Live mode で本人確認完了 (個人事業主、身分証提出)
- [x] クレジット取引セキュリティチェックリスト 1.1〜1.12 すべて「はい」
- [x] 公開事業情報 placeholder データを実値に置換 (= サポート住所 / 電話 / メール / ウェブサイト)
- [x] Live mode で Product / Meter / Price 5 件を再作成 (= Haiku ¥10 / Sonnet ¥15 / Embedding ¥5 / DB容量 ¥1 / Storage ¥1)
- [x] Live mode で Webhook エンドポイント `tasukiba-production-webhook` 追加 + 11 イベント購読 + API バージョン `2026-04-22.dahlia` 一致
- [x] Live mode の Customer Portal を Sandbox と同じ設定で構築 (キャンセル / プラン切替 / 数量変更 OFF)
- [x] Live mode の Smart Retries / メール通知設定 (2 週間 / 8 回 / 期限超過保持)
- [x] Live API キー (`sk_live_xxxx`、Restricted Key) + Webhook secret (`whsec_xxxx`) を Netlify Production 環境変数に登録
- [x] `STRIPE_PRICE_*` 5 件を Live mode の Price ID に置換 (= Live Account ID `KHIaXKbo0M` 埋め込み確認、Sandbox ID `K3TUQWW2eq` 混入なし)
- [x] **PR-V8 完了**: コード側の API バージョン `2026-04-22.dahlia` + Meter API 対応完了 (= PR #411 にバンドル merge 済)
- [x] 利用規約 / 特商法に Stripe 決済 / 自動更新条項が反映済
- [x] LP `#tokushoho` アンカーが Live mode の特商法 URL に設定済

### 切替時の罠 (本セッションで実検出、KDD §5.X+ に記録予定)
1. **過去 Sandbox testing で populate された `tenant.stripeCustomerId`** が Live API key で retrieve 失敗し 503 を返す → DB cleanup SQL で全 Stripe ID を NULL 化して再 setup
2. **`STRIPE_PRICE_EMBEDDING` Production が Sandbox 値のまま** → Subscription 作成時に `No such price` 400 で fail。env の Live ID 化 + Stripe Customer 削除 + DB cleanup で復旧
3. **(参考)** auto-tag.service.ts が Anthropic structured output 未サポートの `maxItems` を含め全リクエスト 400 reject されていた (TC-L6a 検証時に発覚) → schema から `maxItems` 撤去 + dedup() で件数上限カットオフに変更

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
