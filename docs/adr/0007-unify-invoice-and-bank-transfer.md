# ADR-0007: `invoice` と `bank_transfer` の支払い方法を統合 (UI ラベル「銀行振込」, 内部値 `invoice`)

- **Status**: Accepted
- **Date**: 2026-05-15
- **Deciders**: super_admin (運営)

---

## Context (背景)

v1 (2026-06-01) リリース時点で `Tenant.paymentMethod` には以下 3 値を定義していた:

| 値 | 想定運用 | 当時の意図 |
|---|---|---|
| `invoice` | 請求書送付 (PDF を `billingContactEmail` 宛にメール送信) | 「請求書ベースで支払う」=月末請求書ベースの取引 |
| `bank_transfer` | 銀行振込 (請求書に振込先記載) | 「銀行振込で支払う」=支払い手段としての銀行振込 |
| `credit_card` | Stripe Metered Billing による自動引き落とし | クレジットカード自動引落 ([ADR-0006](./0006-stripe-metered-billing-integration.md)) |

### 問題

実装を進めた結果、`invoice` と `bank_transfer` は **コードレベルでは完全に同一処理** であった:

1. **同じフロー**: どちらも super_admin が CSV → 請求書 PDF 手作成 → メール送付 → 銀行振込で受領 → 手動消込
2. **同じ運用 SOP**: [PAYMENT_DELINQUENCY_SOP.md](../operations/PAYMENT_DELINQUENCY_SOP.md) / [BILLING_MONTHLY_OPERATIONS.md](../operations/BILLING_MONTHLY_OPERATIONS.md) で両者を一括して扱っている
3. **同じ UI 説明文**: `/settings/tenant` の Stripe 支払い方法セクションで両者の説明文が完全一致 (「月末締めの翌月25日支払で、毎月請求書 PDF を請求担当者メールにお送りしています」)
4. **同じ Stripe 連携の影響**: Stripe 連携対象外 (= `credit_card` のみが連携対象)

ユーザ視点では「請求書送付」と「銀行振込」のどちらを選んでも:
- 請求書 PDF が請求担当者メールに届く
- 銀行振込で支払う
- super_admin が手動消込する

つまり、**支払い方法の選択肢として並べると区別の意味がなく、ユーザに不必要な疑問を与える** ことが判明した。

## Decision (決定)

**`invoice` と `bank_transfer` を統合し、`invoice` 単一値に集約する。** UI ラベルは「銀行振込」とする。

### 統合方針

| 項目 | 統合前 | 統合後 |
|---|---|---|
| **内部値 (DB / API)** | `'invoice'` / `'bank_transfer'` の 2 値 | `'invoice'` 単一値 |
| **UI ラベル** | 「請求書送付」/「銀行振込」 | 「銀行振込」単一 |
| **API バリデーション** | `z.enum(['invoice', 'bank_transfer'])` | `z.enum(['invoice'])` (`bank_transfer` は VALIDATION_ERROR) |
| **既存 DB レコードの旧 `bank_transfer` 値** | (そのまま) | 読み込み時は `invoice` と同等扱い (= 「銀行振込」表示)、PATCH 時に invoice 正規化 |
| **DB マイグレーション** | — | **なし** (新規 DB 値の追加・enum 化はせず、既存値は画面操作で自然に統一) |

### 採用しなかった代替案

| 案 | 採用しない理由 |
|---|---|
| **B: 内部値を `bank_transfer` 側に統一** | 既存 `invoice` レコードの数が圧倒的に多い (デフォルト値だった) ため、変更範囲が拡大しコード変更量も増える。BillingHistory / Stripe webhook / cron など 30+ ファイルの判定書換が必要 |
| **C: 新規値 `manual_billing` を追加** | 影響範囲最大。既存全テナントレコードの UPDATE + 全コードベースの判定書換が必要 |
| **現状維持** | ユーザに不必要な疑問を与え続ける問題が解消しない |

### 採用案 (A 案 = `invoice` 統一) の利点

- **コード変更量最小**: 既存 `=== 'invoice'` 判定はそのまま残せる
- **DB マイグレーション不要**: 既存 `bank_transfer` レコードは読み込み時の fallback で「銀行振込」と表示される (= UI 上は正しく統合される)
- **後方互換性**: 旧 API クライアントが `bank_transfer` を送ってきても `VALIDATION_ERROR` を返すだけで、サービス全体は壊れない

### トレードオフ

- **UI ラベルと内部値の乖離**: 「銀行振込」ラベルなのに内部値は `invoice` で不整合。ただし将来クレジットカード以外の支払い手段を追加する可能性も低いため、長期メンテ性への影響は限定的と判断
- **既存 DB レコードの bank_transfer 値が残る**: 画面で開いて保存し直さない限り DB 上は `bank_transfer` のまま。ただし読み込み時に正規化するため UI 上は問題なし。本番 DB の旧 `bank_transfer` テナント数は数件レベル (Default テナント等) のため許容範囲

## Consequences (影響)

### 利点

- ユーザが「請求書支払い」と「銀行振込」の違いに悩まなくなる
- 運用 SOP / ドキュメントから「invoice / bank_transfer」並記が消え、可読性が向上
- 将来クレジットカード払いとの 2 択シンプル構造になる

### コスト

- 既存 docs 8 ファイル + コード 9 ファイル + テスト 2 ファイルの修正 (1 PR で完結)
- 既存 `bank_transfer` テナント (本番 DB で数件) のラベル表示が「銀行振込」のまま変わらない (= 元から「銀行振込」表示だったため UX 上の変化はなし)

### 残課題

- 本番 DB の `bank_transfer` レコードを `invoice` に正規化したい場合は、画面から「銀行振込」を選択して保存することで自然に統一される (運営判断)
- 将来 enum 化する場合は別 ADR で扱う

## 関連

- 統合実装 PR: `feat/unify-payment-method-invoice` ブランチ (2026-05-15)
- [PAYMENT_TERMS.md](../business/PAYMENT_TERMS.md) §0.2 — 支払い方法定義 (本 ADR を受けて更新)
- [STRIPE_BILLING.md](../business/STRIPE_BILLING.md) — Stripe 連携仕様
- [ADR-0006](./0006-stripe-metered-billing-integration.md) — Stripe Metered Billing 導入
