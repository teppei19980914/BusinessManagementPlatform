# ADR-0029: Embedding 従量課金の単価改定 — Expert/Pro ¥1 → ¥5/call (2026-05-30)

- **Status**: Accepted (2026-05-30)
- **Date**: 2026-05-30
- **Deciders**: teppei
- **Supersedes (partial)**: [ADR-0022](./0022-embedding-usage-based-billing.md) (Embedding 従量課金の単価のみ ¥1 → ¥5 に改定。課金対象 featureUnit・Beginner ¥0 維持・backfill 無料・計測単位は ADR-0022 を継承し変更しない)
- **Related (上限ロジック)**: [ADR-0030](./0030-embedding-monthly-budget-cap.md) で「ADR-0022 の上限ロジック (= Embedding は予算上限と独立)」を部分上書き。Expert/Pro 個別予算上限 `monthlyEmbeddingBudgetCapJpy` を新設、Beginner Embedding 100 件試用上限を新設。本 ADR の単価 ¥5/call は ADR-0030 の予算換算根拠として参照される
- **関連**: [src/config/embedding-pricing.ts](../../src/config/embedding-pricing.ts) (`EMBEDDING_PRICE_JPY_BY_PLAN`) / [docs/design/STRIPE_EMBEDDING_PRICE_SETTINGS.md](../design/STRIPE_EMBEDDING_PRICE_SETTINGS.md) (Stripe as-built) / [docs/design/STRIPE_ENV_MAPPING.md](../design/STRIPE_ENV_MAPPING.md)

---

## Context

[ADR-0022](./0022-embedding-usage-based-billing.md) (2026-06-01) で Embedding 系 7 featureUnit (knowledge / risk-issue / retrospective / memo embedding + chat-semantic-search + external-import-embedding + attachment-embedding) を Expert/Pro で **¥1/call** の従量課金とした。

その後の見直しで、以下の理由から単価を **¥5/call** に引き上げる:

1. **収益性の適正化**: ¥1/call は Voyage 実コスト ¥0.036/call の約 27 倍だが、Embedding は提案エンジン・チャット検索という中核機能であり、利用ボリュームに対する課金が薄すぎた。¥5/call (= Voyage 実コストの約 139 倍) でも「LLM 課金 (Expert ¥10 / Pro ¥15) より十分安い」価格帯を保てる。
2. **価格体系の一貫性**: per-call 課金の LLM (¥10/¥15) と比較し、Embedding ¥1 は相対的に廉価すぎてプラン内の価格バランスが崩れていた。¥5 で「LLM の約 1/2〜1/3」という分かりやすい位置づけになる。
3. **クレジットカード払いの本稼働**: ADR-0022 想定の「リリース時 credit_card 未対応」から状況が進み、credit_card 払いが有効化済み。Stripe Price も ¥5 で Sandbox / Live 両環境に設定済みのため、コード定数と一致させる必要がある。

### 制約 (ADR-0022 から継承、変更しない)

- **Beginner 「90 日完全無料」訴求は絶対保全** → Beginner Embedding 単価は **¥0 据置**。
- **backfill (cron 自動リカバリ) は全プラン ¥0 据置** (= 不当請求回避)。
- **Beginner 50 件上限 / monthlyBudgetCap の判定対象外** は不変 (Embedding は必須機能のため)。
- **Fair Use Limit (Beginner 専用、月 10,000 calls)** は継続 (経済的攻撃の閾値計算のみ ¥1→¥5 で更新)。
- **bulk は 1 業務操作 = 1 ApiCallLog = 1 課金** (CSV 100 件取込でも 1 課金) は不変 → 単価のみ ¥5。

---

## Decision

### 1. 単価改定

| プラン | ADR-0022 (旧) | ADR-0029 (新) |
|---|---|---|
| Beginner | ¥0 / call | **¥0 / call (据置)** |
| Expert | ¥1 / call | **¥5 / call** |
| Pro | ¥1 / call | **¥5 / call** (Expert と同単価 = plan 間で品質差なし) |

真実源は [src/config/embedding-pricing.ts](../../src/config/embedding-pricing.ts) の `EMBEDDING_PRICE_JPY_BY_PLAN`。

### 2. 請求 invariant (最重要)

Embedding は **「Stripe Meter quantity = 呼出回数 (=1) × Stripe Price 単価 (¥5/unit)」** 方式 (= Haiku/Sonnet と同型。DB/Storage 超過の「quantity = 円整数 × ¥1/unit」とは異なる)。

```
credit_card テナント : StripeUsageRecordQueue.quantity(=1) × Stripe Price ¥5/unit       = 請求額
invoice/bank_transfer: ApiCallLog.costJpy (= resolveEmbeddingCostJpy = ¥5) の SUM        = 請求額
```

→ **コード定数 ¥5 と Stripe Price ¥5/unit を必ず一致させる** ([[feedback_billing_invariant]])。本 ADR では両方を ¥5 に揃える。

### 3. migration 不要

Embedding 単価は **DB カラムではなくコード定数**。LLM 単価 (`pricePerCallHaiku/Sonnet` = Tenant カラム、ADR-0019 では migration 必要) と異なり、`EMBEDDING_PRICE_JPY_BY_PLAN` の変更のみで反映される。

### 4. 既存 ApiCallLog は不変

改定前に記録済みの `ApiCallLog.costJpy = 1` の行は **immutable**。SUM に新旧混在する設計 (= 過去請求への遡及なし)。改定デプロイ以降の新規 call から ¥5 が適用される。

### 5. Stripe 実設定 (2026-05-30 確認済)

| 環境 | Embedding Price ID | 単価 | Meter event_name |
|---|---|---|---|
| Sandbox (Test) | `price_1TchuCK3TUQWW2eqQ278OqEI` | ¥5 | `tasukiba_embedding_call` |
| Live | `price_1Tchn2KHIaXKbo0M5OYQAQUN` | ¥5 | `tasukiba_embedding_call` |

詳細は [STRIPE_EMBEDDING_PRICE_SETTINGS.md](../design/STRIPE_EMBEDDING_PRICE_SETTINGS.md) / [STRIPE_ENV_MAPPING.md](../design/STRIPE_ENV_MAPPING.md)。

---

## Consequences

### Positive
- 収益性が改善 (Expert/Pro で月 1000 件 embedding 利用 → ¥1,000 → **¥5,000** 売上)。Voyage 実コスト ¥36 を大きく上回る。
- LLM 課金との価格バランスが整い、プラン内の価格説明が一貫する。
- credit_card / invoice 双方で ¥5 に揃い、請求 invariant が維持される。

### Negative / リスク
- **既存 Expert/Pro 契約者への影響**: 5 倍の値上げ。既存契約者がいる場合は規約改定 + 事前告知 (30 日前メール + サービス内バナー) が必要 (ADR-0022 §同項を継承)。本改定時点の契約状況は別途確認 (Stripe Sandbox/Live とも embedding 有効サブスク 0)。
- **Beginner→Expert/Pro アップセル時の説明更新**: 「資産入力は Expert/Pro で ¥5/業務操作」と各所の文言・例計算を更新する必要 (公開 / 内部ドキュメント横展開)。

### 影響範囲 (ドキュメント横展開)
- コード: `embedding-pricing.ts` 定数 + 関連 test / UI 文言 / コメント (本 ADR と同 PR で完了)。
- 公開 doc: api-usage-guide.md / about.md / plan-guide.md (例計算 ¥1×N → ¥5×N の再計算含む)。
- 内部 doc: STRIPE_BILLING / GLOSSARY / DATA_MODEL / TENANT_AND_BILLING / PER_CALL_COST_BREAKDOWN / KDD_PATTERNS。
- 外部 (HomePage): 製品紹介ページの Embedding 単価記述。

---

## 改定履歴

| 日付 | ADR | 内容 |
|---|---|---|
| 2026-06-01 | [ADR-0022](./0022-embedding-usage-based-billing.md) | Embedding 従量課金導入 (Expert/Pro ¥1/call、Beginner ¥0) |
| 2026-05-30 | ADR-0029 (本書) | **Embedding 単価を Expert/Pro ¥1 → ¥5/call に改定** (Beginner ¥0・backfill 無料・対象 featureUnit・上限ロジックは不変) |
