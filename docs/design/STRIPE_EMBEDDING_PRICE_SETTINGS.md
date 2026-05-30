# Stripe 実設定記録 — Embedding 課金 Price (¥1 → ¥5 改定 / 2026-05-30)

最終更新: 2026-05-30
ステータス: **ドラフト (二人三脚で実値確認中)** — ⚠️ `要確認` 欄は Stripe Dashboard の実値を反映してから確定とする

> ✅ **2026-05-30 整合完了**: credit_card 払いは **既に有効化済** (`STRIPE_ENABLED=true`、Production env 全 5 Price 設定済)、
> Stripe Price も ¥5 で設定済み。~~リポジトリ内の複数 docs (CLAUDE.md / [src/lib/stripe.ts](../../src/lib/stripe.ts) コメント /
> [ADR-0022](../adr/0022-embedding-usage-based-billing.md) / [STRIPE_SETUP.md §2.2-bis](../operations/STRIPE_SETUP.md) の
> 「リリース時は credit_card 未対応・将来 Stripe 有効化時」記述) は実態より古い~~ → 同セッション内で **全 docs 是正完了** (ADR-0022 / STRIPE_SETUP / STRIPE_BILLING / ENV_VARS / src/lib/stripe.ts / src/services/stripe-billing.service.ts / src/lib/llm/metered.ts / ADR-0006 / ADR-0020 / ADR-0021 / STRIPE_TECHNICAL_DESIGN.md)。
関連:
- ADR: [ADR-0022](../adr/0022-embedding-usage-based-billing.md) (Embedding 従量課金の初版、Expert/Pro ¥1) / **改定 ADR は本対応で新規作成予定 (ADR-0029 想定)**
- 仕様: [STRIPE_BILLING.md](../business/STRIPE_BILLING.md)
- 詳細技術設計: [STRIPE_TECHNICAL_DESIGN.md](./STRIPE_TECHNICAL_DESIGN.md)
- 設定手順: [STRIPE_SETUP.md](../operations/STRIPE_SETUP.md) §2.2-bis
- コード単価: [src/config/embedding-pricing.ts](../../src/config/embedding-pricing.ts) `EMBEDDING_PRICE_JPY_BY_PLAN`
- Meter event 名: [src/lib/stripe.ts](../../src/lib/stripe.ts) `STRIPE_METER_EVENT_NAMES.embedding`

> 本書の目的: Stripe Dashboard で実際に作成・変更した **Embedding 課金 Price / Meter / Product の実設定値** を
> リポジトリ側の単一の真実源 (コード定数・env・ADR) と突き合わせ、**請求 invariant の整合**を担保する記録。
> 「設定手順 (how-to)」は [STRIPE_SETUP.md](../operations/STRIPE_SETUP.md)、「実際にどう設定したか (as-built)」は本書が担う。

---

## 1. 改定サマリ

| 項目 | 改定前 | 改定後 | 備考 |
|---|---|---|---|
| Expert Embedding 単価 | ¥1 / 業務操作 | **¥5 / 業務操作** | code 定数 + Stripe Price 両方 |
| Pro Embedding 単価 | ¥1 / 業務操作 | **¥5 / 業務操作** | Expert と同単価 (品質差なしのため) |
| Beginner Embedding 単価 | ¥0 | **¥0 (据置)** | 「90 日完全無料」訴求保全。変更なし |
| embedding-backfill (cron 自動リカバリ) | ¥0 | **¥0 (据置)** | 不当請求回避。変更なし |
| Stripe Price (`tasukiba_embedding_call` 紐付け) | ¥1 / unit | **¥5 / unit** | Stripe Dashboard で変更済 (2026-05-30) |

### 課金経路と invariant (最重要)

Embedding は **「quantity = 呼出回数 (=1)」を送り、単価は Stripe Price 側 (¥5/unit) で乗算**する方式
(= Haiku/Sonnet と同型。DB容量/ファイルストレージ超過の「quantity=円整数 × ¥1/unit」方式とは異なる)。

```
credit_card テナント:  StripeUsageRecordQueue.quantity (=1) × Stripe Price 単価 (¥5/unit) = 請求額
invoice/bank_transfer: ApiCallLog.costJpy (= resolveEmbeddingCostJpy = ¥5) の SUM       = 請求額
```

→ **コード定数 `EMBEDDING_PRICE_JPY_BY_PLAN.expert/pro = 5` と Stripe Price 単価 ¥5/unit が一致して初めて、
   同一利用量に対し credit_card と invoice の請求が一致する** ([[feedback_billing_invariant]])。
   片方だけ変更すると課金経路間で金額が乖離するため、**必ず同時に揃える**。

---

## 2. Stripe Dashboard 実設定値 (as-built)

> 🖼️ 2026-05-30 のスクリーンショットで確認できた範囲を記載。残りは `要確認`。

### 2.1 Product (商品) — Sandbox (Test mode) 確定 2026-05-30

| 項目 | 値 | 出典 |
|---|---|---|
| 商品名 | `たすきば Embedding 課金 (Expert / Pro)` | スクリーンショット ✅ |
| ステータス | 有効 (active) | スクリーンショット ✅ |
| Product ID (Sandbox) | **`prod_Ubvls2SNagrxLr`** | スクリーンショット ✅ |
| Product ID (Live) | **`prod_Ubvesvw7mBAV8y`** | スクリーンショット ✅ |
| 説明 (Sandbox) | `…1 業務操作 ¥1 (ADR-0022)。Beginner は無料` | ⚠️ **「¥1 (ADR-0022)」のまま → Dashboard で ¥5 / ADR-0029 に要更新** |
| 説明 (Live) | `Expert/Pro プランの Embedding 業務操作 1 回あたり ¥1 (ADR-0022 / 2026-06-01)。Beginner は ¥0 (= queue 不投入)` | ⚠️ **「¥1」のまま → ¥5 / ADR-0029 に要更新** |

### 2.2 Price (料金) — Sandbox 確定

| 項目 | 値 | 出典 |
|---|---|---|
| 単価 | **¥5 per ユニット** | スクリーンショット ✅ |
| 通貨 | **JPY** | 価格詳細 ✅ |
| 請求期間 | 1 カ月ごと (monthly recurring) | 価格詳細 ✅ |
| 料金モデル | 従量課金 (metered) | 価格詳細 ✅ |
| デフォルト価格か | はい | 価格詳細 ✅ |
| 作成日 | 2026-05-30 (05/30) | スクリーンショット ✅ |
| 有効なサブスク数 | **0** (= 既存サブスクに embedding Item 未追加、後述 §4) | スクリーンショット ✅ |
| Price ID (Sandbox) | **`price_1TchuCK3TUQWW2eqQ278OqEI`** | ユーザ共有 ✅ = staging `STRIPE_PRICE_EMBEDDING` にセットする値 |
| 検索キー (lookup_key) | **未設定 (なし)** ⚠️ 他 Price は `haiku_per_call_v2` 等あり。任意だが付与推奨 (`embedding_per_call`) | 価格詳細に 検索キー 行なし |

### 2.3 Meter (メーター) — Sandbox 確定

| 項目 | 設計上の期待値 | Sandbox 実値 |
|---|---|---|
| イベント名 (event_name) | `tasukiba_embedding_call` (`STRIPE_METER_EVENT_NAMES.embedding`) | **`tasukiba_embedding_call`** ✅ 完全一致 |
| 表示名 | — | `たすきば Embedding 課金` |
| 集計/総計方法 | 合計 (sum) | **合計** ✅ |
| Meter ID | — | `mtr_test_61UljLQ8VIDzUn5FV41K3TUQ…` (要全桁確認) |
| ペイロードキー | `stripe_customer_id` / `value` | **`stripe_customer_id` / `value`** ✅ |
| Meter 作成日 | — | 2026-05-29 08:03 |

> ⚠️ event_name がコード定数と 1 文字でも違うと、`billing.meterEvents.create` が Stripe 側で
> 紐付け先 Meter を見つけられず使用量が記録されない (= credit_card テナントへの請求漏れ)。

### 2.4 環境 (Test / Live) — credit_card 有効化済み

| 環境 | Price ID | env 反映先 | 設定状況 |
|---|---|---|---|
| Test (sandbox, `sk_test_`) | **`price_1TchuCK3TUQWW2eqQ278OqEI`** ✅ | Netlify staging の `STRIPE_PRICE_EMBEDDING` | `要確認` (env に設定済みか) |
| Live (本番, `sk_live_`) | **`price_1Tchn2KHIaXKbo0M5OYQAQUN`** ✅ | Netlify production の `STRIPE_PRICE_EMBEDDING` | `要確認` (env に設定済みか) |

> Meter ID: Sandbox `mtr_test_61UljLQ8VIDzUn5FV41K3TUQ…` / Live `mtr_61Um5j8MR5jzJqZBH41KHIaXKbo0…`。Live Meter 表示名は `Embedding per-call (Expert/Pro)`、いずれも event_name `tasukiba_embedding_call`・sum・payload `stripe_customer_id`+`value` で一致。

> ✅ credit_card 払いは有効化済み (`STRIPE_ENABLED=true`)。`STRIPE_PRICE_EMBEDDING` が
> 新 ¥5 Price ID を指しているか (= `getStripePriceConfig().embedding` が ¥5 Price を返すか) を要確認。
>
> ⚠️ **既存サブスクの Subscription Item 整合 (請求正確性の要)**:
> スクリーンショット上、新 ¥5 Price は「有効なサブスク 0」。一方 credit_card が稼働中なら、
> 既存 Expert/Pro テナントの Subscription Item が **旧 ¥1 Embedding Price を参照したまま** の可能性がある。
> その場合、当該テナントは Stripe 側で ¥1/call のまま課金され、コード/invoice 経路 (¥5) と乖離する。
> → **既存 credit_card Expert/Pro サブスクの embedding Item を新 ¥5 Price へ差し替える migrate が必要**
>   (`stripe.subscriptionItems.update(si_xxx, { price: <新¥5 price_id> })`)。`要確認`: 既存サブスクの有無と現参照 Price。

---

## 3. リポジトリ側との整合チェックリスト

| # | リポジトリ側の値 | 期待 | 現状 | 一致? |
|---|---|---|---|---|
| 1 | `EMBEDDING_PRICE_JPY_BY_PLAN.expert` | 5 | **1** (未改定) | ❌ 要改定 |
| 2 | `EMBEDDING_PRICE_JPY_BY_PLAN.pro` | 5 | **1** (未改定) | ❌ 要改定 |
| 3 | `EMBEDDING_PRICE_JPY_BY_PLAN.beginner` | 0 | 0 | ✅ |
| 4 | `STRIPE_METER_EVENT_NAMES.embedding` | `tasukiba_embedding_call` | `tasukiba_embedding_call` | ✅ Sandbox Meter と完全一致確認済 (2026-05-30) |
| 5 | Stripe Price 単価 (Sandbox) | ¥5/unit | ¥5/unit | ✅ (2026-05-30、price_1TchuCK3…) |
| 6 | Stripe 商品 description (Sandbox/Live 両方) | ¥5 / ADR-0029 | **「¥1」のまま** | ❌ Dashboard で要更新 |
| 7 | Stripe Price 単価 (Live) | ¥5/unit | ¥5/unit ✅ (price_1Tchn2KH…) | ✅ 2026-05-30 確認 |

→ #1 / #2 を改定すれば請求 invariant が再び成立する (詳細 TODO は本対応の調査結果を参照)。

---

## 4. 旧 Price / 既存サブスクの取り扱い (Sandbox 実態反映)

- **旧 ¥1 Embedding Price は Stripe 上に存在しない**: ¥1 はコード定数のみで、Stripe の Embedding 商品は
  2026-05-30 に最初から ¥5 で作成された (= archive 対象の旧 Price なし)。
- ⚠️ **既存サブスクに embedding Item が未追加**: Sandbox では Haiku / Sonnet / DB容量超過 / ファイルストレージ超過 が
  各「有効サブスク 1」なのに対し、**Embedding Price は「有効サブスク 0」**。= 既存の 1 本のテストサブスクは
  Haiku/Sonnet/DB/Storage の Item だけを持ち、**embedding Item を含んでいない**。
  → credit_card で embedding を請求するには、`createSubscriptionForTenant` が `STRIPE_PRICE_EMBEDDING` 設定時に
    embedding Item を追加する経路 ([src/lib/stripe.ts](../../src/lib/stripe.ts)) を確認し、**既存サブスクには
    手動 / コードで embedding Item を追加** する必要がある (`stripe.subscriptionItems.create({ subscription, price: price_1TchuCK3… })`)。
    「¥1→¥5 の差替」ではなく「不足 Item の追加」が正しい操作。
- 既に記録済の `ApiCallLog.costJpy = 1` の行は **immutable** で SUM に新旧混在する設計 (過去請求は不変)。
  改定以降の新規 call から ¥5 が適用される。

---

## 5. 未確定事項 (二人三脚で埋める)

### ✅ Sandbox 確定済 (2026-05-30)
- [x] Embedding Product ID `prod_Ubvls2SNagrxLr` / Price ID `price_1TchuCK3TUQWW2eqQ278OqEI` / Meter event_name `tasukiba_embedding_call` (コード一致)
- [x] 単価 ¥5 / JPY / 月次 / metered / sum 集計 / payload `stripe_customer_id`+`value`
- [x] Embedding 用 Meter は Sandbox に存在し event_name 完全一致

### ✅ Live mode 確定済 (2026-05-30)
- [x] Embedding Product ID `prod_Ubvesvw7mBAV8y` / Price ID `price_1Tchn2KHIaXKbo0M5OYQAQUN` / 単価 ¥5 / JPY / 月次 / metered
- [x] Live Meter event_name `tasukiba_embedding_call` (表示名 `Embedding per-call (Expert/Pro)`) コード一致 / sum / payload 一致
- [x] Live は全 5 Price が有効サブスク 0 (= 本番サブスク未作成、Item 整合問題なし)

### ⏳ 残課題
- [ ] `STRIPE_PRICE_EMBEDDING` env が新 ¥5 Price を指しているか (staging=`price_1TchuCK3…` / production=`price_1Tchn2KH…`)
- [ ] **Stripe 商品 description が Sandbox/Live とも「¥1」のまま** → Dashboard で ¥5 / ADR-0029 に更新
- [ ] **Sandbox 既存サブスクへの embedding Item 追加** (Sandbox は embedding 有効サブスク 0、§4 参照。Live は全 0 で問題なし)
- [ ] Embedding Price の lookup_key (任意。付与するなら `embedding_per_call`)
- [x] 改定 ADR は **ADR-0029 を新規作成** で決定 (2026-05-30)
