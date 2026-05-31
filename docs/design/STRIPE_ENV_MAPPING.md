# Stripe 設定 ↔ 環境変数 対応表 (Sandbox / Live)

最終更新: 2026-05-31
ステータス: **確定 (as-built)** — Price ID / Meter / env context は実値確認済 ([ENVIRONMENT_VARIABLES.md §4](./ENVIRONMENT_VARIABLES.md))。残るのは Dashboard 表示名・lookup_key 統一 (任意・請求無影響) のみ
関連:
- as-built 設定記録: [STRIPE_EMBEDDING_PRICE_SETTINGS.md](./STRIPE_EMBEDDING_PRICE_SETTINGS.md) (Embedding ¥5 改定の個別記録)
- env var 全体 + Netlify context マトリクス: [ENVIRONMENT_VARIABLES.md](./ENVIRONMENT_VARIABLES.md) (env の真実源、2026-05-30 一本化済。旧 `docs/operations/ENV_VARS.md` は archive)
- 設定手順 (how-to): [STRIPE_SETUP.md](../operations/setup/STRIPE_SETUP.md)
- コード: [src/lib/stripe.ts](../../src/lib/stripe.ts) (`getStripePriceConfig` / `STRIPE_METER_EVENT_NAMES` / `isStripeEnabled`)

> **目的**: Stripe の Sandbox (Test mode) と Live mode で作成した各オブジェクト (API key / Webhook / Meter / Price)
> の実値を、対応する環境変数および Netlify deploy context と 1 枚で突き合わせる。価格改定・環境追加のたびに
> 「どの env がどの Stripe オブジェクトを指すか」を即座に追跡できる状態を保つ。
>
> **本書 (design / 値) と STRIPE_SETUP.md (operations / 手順)・ENVIRONMENT_VARIABLES.md (全 env 網羅) の役割分担**:
> 本書は **Stripe オブジェクトの実 ID と env の対応**に特化する。

---

## 0. 前提: 環境とキーの判別

- Stripe SDK は `STRIPE_SECRET_KEY` の prefix で環境を自動判別する ([src/lib/stripe.ts](../../src/lib/stripe.ts)):
  - **Sandbox (Test mode)**: `sk_test_xxx` / publishable `pk_test_xxx`
  - **Live mode**: `sk_live_xxx` / publishable `pk_live_xxx`
- Test と Live は **Product / Price / Meter / Webhook がすべて別オブジェクト** (ID も別)。env も context 別に分離必須。
- API バージョン: `2026-04-22.dahlia` (コード固定、`STRIPE_API_VERSION`)
- 機能 ON/OFF: `STRIPE_ENABLED='true'` のみ有効 (現状 **有効化済み**)

---

## 1. キー / Webhook 系 (環境ごとに別値)

> 設定状況は [ENVIRONMENT_VARIABLES.md §4](./ENVIRONMENT_VARIABLES.md) の as-built 棚卸しで確認済。secret スコープの値は本書には貼らない。

| 環境変数 | 用途 | Sandbox (Test) | Live |
|---|---|---|---|
| `STRIPE_ENABLED` | feature flag (`'true'` で有効) | `true` (Prev/Branch) / `false` (PSAR/Local) | `true` (Prod) |
| `STRIPE_SECRET_KEY` | サーバ API キー | `sk_test_…` 設定済 (Prev/Branch、secret) | `sk_live_…` 設定済 (Prod、secret) |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | ブラウザ用 publishable key | `pk_test_51TYb8uK3…` (平文公開鍵) | `pk_live_51TXEw…` (平文公開鍵) |
| `STRIPE_WEBHOOK_SECRET` | Webhook 署名検証 (`whsec_`) | Test endpoint 設定済 (secret) | Live endpoint 設定済 (secret) |
| `SYSTEM_USER_ID` | cron/Webhook の auditLog 用 system ユーザ UUID | `63cf718f-98cf-4882-9d6d-286441607d16` (全 context 共通) | 同左 |

---

## 2. Price / Meter 系 (Metered Billing)

各従量課金 Price は対応する Stripe **Meter (event_name)** に紐付く。event_name はコード定数
`STRIPE_METER_EVENT_NAMES` ([src/lib/stripe.ts](../../src/lib/stripe.ts)) と**完全一致必須**。

| 環境変数 | 単価 (現行) | Meter event_name (コード固定) | Sandbox Price ID | Live Price ID |
|---|---|---|---|---|
| `STRIPE_PRICE_HAIKU` | ¥10 / call (Expert) | `tasukiba_haiku_api_call` ✅ | `price_1TcLQIK3TUQWW2eqMEBsEFqF` | `price_1TcPQVKHIaXKbo0MNGUwQPPq` |
| `STRIPE_PRICE_SONNET` | ¥15 / call (Pro) | `tasukiba_sonnet_api_call` ✅ | `price_1TcLRIK3TUQWW2eqohr0tuUm` | `price_1TcPRVKHIaXKbo0MW3WityQ5` |
| `STRIPE_PRICE_EMBEDDING` | **¥5 / call** ← 🆕 ¥1→¥5 改定 (ADR-0029) | `tasukiba_embedding_call` ✅ | `price_1TchuCK3TUQWW2eqQ278OqEI` | `price_1Tchn2KHIaXKbo0M5OYQAQUN` |
| `STRIPE_PRICE_DB_CAPACITY_OVERAGE` | ¥1 / unit (円整数 quantity) | `tasukiba_db_capacity_overage_jpy` ✅ | `price_1TcLTmK3TUQWW2eqDlp4iJGk` | `price_1TcPSCKHIaXKbo0MTtJECpBH` |
| `STRIPE_PRICE_STORAGE_FILE_OVERAGE` | ¥1 / unit (円整数 quantity) | `tasukiba_storage_file_overage_jpy` ✅ | `price_1TcLdlK3TUQWW2eqXU09bsd2` | `price_1TcPSxKHIaXKbo0M22Qz1bTN` |

> ✅ **2026-05-30 確定**: 5 Price × Sandbox/Live = 10 件すべての Price ID と Meter event_name をスクリーンショット/ユーザ共有で確認。**event_name は全 10 件ともコード定数 `STRIPE_METER_EVENT_NAMES` と完全一致**。
>
> **Product ID 参考**:
> | 商品 | Sandbox Product | Live Product |
> |---|---|---|
> | Embedding | `prod_Ubvls2SNagrxLr` | `prod_Ubvesvw7mBAV8y` |
> | Haiku | `prod_UbYXe3HeRJjMYe` | `prod_Ubcf5qPzL7kIMB` |
> | Sonnet | `prod_UbYYEnufj5X6tl` | `prod_Ubcg2xrnpFzZGI` |
> | DB容量超過 | `prod_UbYaZfPLsvFhXt` | `prod_UbchZspeLNiNB1` |
> | Storage超過 | `prod_UbYl5dIUGAO2YV` | `prod_UbciNqK8w0tN0E` |
>
> ⚠️ **環境間で商品名が不統一** (例: Sandbox `たすきば ファイルストレージ超過 (従量課金)` vs Live `ファイルストレージ超過 (従量)`、Sandbox `Haiku per-call (Expert plan)` vs Live `Expert プロジェクト操作 (Haiku)`)。請求には影響しない (コードは event_name/Price ID 参照) が、運用上は表示名を揃えると混乱が減る。
> ⚠️ **lookup_key の不統一**: Sandbox の Haiku/Sonnet/DB/Storage には `haiku_per_call_v2` / `*_jpy` 等の検索キーがあるが、**Embedding (両環境) と Live の全 Price には lookup_key が未設定**。コードは Price ID 直接参照 (env) のため動作影響なしだが、付与すると Dashboard 運用が楽になる。

> **課金方式の違い (重要)**:
> - `HAIKU` / `SONNET` / `EMBEDDING`: quantity = **呼出回数 (=1)**、単価 = per-call の円。→ Price 単価がそのまま per-call 額。
> - `DB_CAPACITY_OVERAGE` / `STORAGE_FILE_OVERAGE`: quantity = **円整数**、単価 = ¥1/unit。→ アプリ算出額をそのまま送る (R6 案 A)。
>
> 🆕 **Embedding ¥1→¥5 改定 (2026-05-30)**: 上表 `STRIPE_PRICE_EMBEDDING` は新 ¥5 Price ID を指す必要がある。
> コード定数 `EMBEDDING_PRICE_JPY_BY_PLAN.expert/pro` も同値 (¥5) であること = 請求 invariant ([STRIPE_EMBEDDING_PRICE_SETTINGS.md](./STRIPE_EMBEDDING_PRICE_SETTINGS.md))。

### 廃止済 (env 削除可 / Stripe では archive)

| 環境変数 | 状態 |
|---|---|
| `STRIPE_PRICE_STORAGE_PLUS` | ADR-0020 (2026-05-25) で廃止 (4 段階 Storage プラン撤廃) |
| `STRIPE_PRICE_STORAGE_PRO` | 同上 |

---

## 3. Netlify deploy context との対応

| 環境変数 | production | deploy-preview | branch-deploy | local (.env) |
|---|---|---|---|---|
| `STRIPE_SECRET_KEY` | `sk_live_` | `sk_test_` | `sk_test_` | `sk_test_` |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | `pk_live_` | `pk_test_` | `pk_test_` | `pk_test_` |
| `STRIPE_WEBHOOK_SECRET` | Live endpoint | Test endpoint | Test endpoint | Stripe CLI listen で都度 |
| `STRIPE_PRICE_*` (全 Price ID) | Live `price_` | Test `price_` | Test `price_` | Test `price_` |
| `STRIPE_ENABLED` | `true` | `true` (TC 実行時) | 任意 | 通常 `false` |

> ⚠️ **Live を preview/branch/local に共有しない** (本番カードへの誤課金リスク)。詳細手順は [ENVIRONMENT_VARIABLES.md §12](./ENVIRONMENT_VARIABLES.md)。

---

## 4. ✅ ENV_VARS ドリフト是正 (解決済 / 2026-05-30〜31)

> **このドリフトは解決済**。env var の真実源は旧 `docs/operations/ENV_VARS.md` から
> **[docs/design/ENVIRONMENT_VARIABLES.md](./ENVIRONMENT_VARIABLES.md)** に一本化された (2026-05-30、旧 ENV_VARS.md は `docs/archive/` へ移動 + tombstone リダイレクト)。
> 同書 §4 (Stripe) の context マトリクスは現行 Price 構成 (5 本) と整合済:
>
> - ✅ 廃止済 `STRIPE_PRICE_STORAGE_PLUS` / `STRIPE_PRICE_STORAGE_PRO` は不掲載
> - ✅ `STRIPE_PRICE_EMBEDDING` (¥5, ADR-0029) / `STRIPE_PRICE_DB_CAPACITY_OVERAGE` / `STRIPE_PRICE_STORAGE_FILE_OVERAGE` を Production=Live / その他=Test の分離込みで掲載済
>
> 以後、env の context 別実値は [ENVIRONMENT_VARIABLES.md §4](./ENVIRONMENT_VARIABLES.md)、Stripe オブジェクト ID と env の対応は本書 §1〜§3 を参照する。

---

## 5. 未確定事項 (二人三脚で埋める)

### ✅ 確定済 (2026-05-30)
- [x] Sandbox / Live の全 `STRIPE_PRICE_*` 実 Price ID (§2、10 件)
- [x] 各 Meter event_name が Sandbox / Live 双方に存在しコード定数と完全一致

### ✅ 確定済 (2026-05-30〜31、[ENVIRONMENT_VARIABLES.md §4](./ENVIRONMENT_VARIABLES.md) の as-built 棚卸しで確認)
- [x] `STRIPE_SECRET_KEY` / publishable / `STRIPE_WEBHOOK_SECRET` の Netlify context 別 設定有無 (Prod/Prev/Branch のみ設定、PSAR/Local 空 + `STRIPE_ENABLED=false`)
- [x] `STRIPE_PRICE_EMBEDDING` env が新 ¥5 Price を指している (production=`price_1Tchn2KH…` Live / staging=`price_1TchuCK3…` Test)
- [x] `STRIPE_PRICE_*` 他 4 本も env が現行 Price ID を指している (Haiku/Sonnet/DB/Storage、Prod=Live / 他=Test 分離済)
- [x] `SYSTEM_USER_ID` = `63cf718f-98cf-4882-9d6d-286441607d16` (seed の system ユーザ UUID、全 context)

### ⏳ 残課題
- [ ] (任意) 環境間の商品名・lookup_key 統一 (請求影響なし、Dashboard 運用性のみ)
