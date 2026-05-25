# ADR-0006: Stripe Metered Billing 連携によるクレジットカード自動引き落としの導入

- **Status**: Accepted (価格改定は [ADR-0019](./0019-billable-feature-units-and-free-tier-expansion.md) で 2026-05-24 に反映)
- **Date**: 2026-05-14
- **Deciders**: super_admin (運営)

> 🆕 **ADR-0019 (2026-05-24) 価格改定**: 本 ADR で確定した Stripe Metered Billing 統合は **継続有効** だが、Price 単価 (Expert ¥5 → ¥10、Pro ¥15 据置) と課金対象 (BILLABLE_FEATURE_UNITS のみ) は ADR-0019 で再定義済。実装変更点 (新 Haiku Price 発行 + ENV 切替 + Subscription Item migrate) は [STRIPE_SETUP.md](../operations/STRIPE_SETUP.md) §2.1 参照。

---

## Context (背景)

たすきば Knowledge Relay は v1 (2026-06-01) で **per-API-call 従量課金** を採用してリリースした。v1 時点の支払い手段は `invoice` (請求書送付) / `bank_transfer` (銀行振込) のみで、いずれも **super_admin による手動運用** に依存している ([docs/business/PAYMENT_TERMS.md §0.2](../business/PAYMENT_TERMS.md))。

> 2026-05-15 注記: `invoice` と `bank_transfer` はユーザ視点で同一フロー (請求書 PDF 受領 → 銀行振込) のため [ADR-0007](./0007-unify-invoice-and-bank-transfer.md) で `invoice` に統合済 (UI ラベル「銀行振込」)。本 ADR の以下の記述で `bank_transfer` が言及される箇所は履歴として残置するが、現在の内部値は `invoice` 単一である。

### 現状の課題

1. **手動運用コスト**: super_admin が毎月以下を手動実行している
   - CSV エクスポート → 請求書 PDF 手作成 → メール送付
   - 銀行口座を見て入金消込 (翌月 16〜25 日、26 日朝に未入金リスト確認)
   - 滞納時は PAYMENT_DELINQUENCY_SOP に沿って手動催促・read-only 移行

2. **スケーラビリティの限界**: 顧客数 10 件未満なら手運用で回るが、それ以上は破綻する想定 ([PAYMENT_TERMS.md §0.1](../business/PAYMENT_TERMS.md))

3. **顧客側の手間**: 銀行振込は顧客の経理部署を介する → 業務効率を損なう

4. **キャッシュフローの不安定さ**: 振込タイミングが顧客次第 → 月次キャッシュフロー予測が難しい

5. **既存ドキュメントの言及**: [TENANT_AND_BILLING.md §34.14.8](../business/TENANT_AND_BILLING.md) で「v1.x で Stripe Metered Billing 連携を実装予定」と明記されている

### 制約

- **ハルシネーション防止 (CLAUDE.md)**: 採用する API・関数・フラグは Stripe 公式ドキュメントで実在確認すること
- **MVP 範囲**: v1 で実装済の手動運用と並存させる (= 既存顧客に強制移行しない)
- **既存 PR #372 (Tenant.suspendedAt) との整合**: read-only 強制移行機能を流用し、引き落とし失敗時の自動 suspend に活用する
- **インボイス制度対応 (2023〜)**: 法人顧客向けに適格請求書 + JCT 登録番号の明示が必要

「決めないと先に進めない理由」: 課金プラットフォームは多くの設計判断 (税計算、決済プロバイダ、課金モデル、Webhook 構造) が **後戻り困難** なため、コードを書く前に方針を確定する必要がある。

---

## Decision (採用した決定)

**Stripe Metered Billing による自動引き落とし機能を v1.x で実装する**。詳細仕様は [docs/business/STRIPE_BILLING.md](../business/STRIPE_BILLING.md) を参照。

### 主要な決定事項

1. **決済プロバイダ**: Stripe (TENANT_AND_BILLING.md の既存方針を踏襲)
2. **既存テナント扱い**: デフォルト `invoice` で開始、顧客が任意で `credit_card` に切替 (並存方式)
3. **課金モデル**: 月末確定 Metered Billing (= 各 API 呼び出しで Usage Record をリアルタイム送信、月末に Stripe が自動集計・自動引き落とし)
4. **カード登録タイミング**: クレジットカード払い設定切替時 + プラン変更時の自動カード検証
5. **引き落とし失敗時**: Stripe Smart Retries (4 回 / 1日, 3日, 5日, 7日) → 全失敗後 +3 日で PR #372 の `suspendTenant()` を自動呼出
6. **消費税**: Stripe Tax を有効化 (インボイス制度対応 + JCT 登録番号自動表記)
7. **手数料負担**: 自社負担 (Stripe 3.6% + カードブランドごとの 0.4-1.0% を運営が吸収、顧客にはプラン料金グロスで請求)
8. **Customer Portal 採用**: カード更新 / 履歴閲覧は Stripe 側 UI に委譲
9. **1 アクション完結フロー (2026-05-14 追加確定)**: カード登録と支払い方法切替を **一体化**。
   - `POST /api/tenants/me/billing/stripe/setup` 開始 → Stripe Checkout → `GET /api/.../setup/complete` (= 自動完了ハンドラ) → paymentMethod 自動切替 + Subscription 作成
   - 失敗時 (= キャンセル / 検証失敗 / カード拒否) は `tenant.paymentMethod` を変更せず、設定前 (= invoice) のまま維持。「巻き戻しロジック」不要
   - 中間状態 (= 「カード登録済だが切替前」) は **存在しない**。UI 状態モデルは A → C / A → A (失敗) の 2 経路のみ

### 適用範囲

- **新規テナント**: デフォルト `paymentMethod = 'invoice'` で作成。顧客が `/settings/tenant` でクレジットカード払いに切替可能
- **既存テナント**: 強制移行はしない。任意のタイミングで切替可
- **Default テナント (運営者自身)**: クレジットカード払い未対応 (= 内部運用テナントのため対象外)

### 適用しないもの (= v2 以降の検討範囲)

- 同一テナントへの複数カード登録 (= MVP は default 1 枚のみ)
- 3D Secure フローのカスタマイズ (= Stripe 標準フローに委任)
- 個別顧客の拒否ルール (= Stripe Radar 標準設定のみ)
- 複数通貨 (USD / EUR)

---

## Consequences (影響)

### Positive

- **super_admin の手動運用がほぼゼロに**: クレジットカード払いのテナントは、Stripe Webhook で月末引き落とし → 自動消込 → 滞納時の自動 suspend まで完全自動化
- **キャッシュフローの予測可能性**: 月末に確実に引き落とされるため、月次収支が予測可能
- **顧客体験の向上**: 銀行振込を経理部署にお願いする手間がなくなる
- **コンプライアンス強化**: Stripe Tax でインボイス制度・適格請求書を自動生成、JCT 登録番号も自動表記
- **既存実装の流用**: PR #372 の `Tenant.suspendedAt` (read-only 強制移行) を引き落とし失敗時に再利用 → 重複実装ゼロ
- **PCI DSS スコープ最小化**: カード番号は Stripe Checkout / Customer Portal で受領 → 自社の PCI 対応は SAQ A レベルで済む

### Negative / Trade-off

- **手数料 3.6%+ の負担**: 顧客の利用料に対し約 4% が Stripe に流れる (= 売上の純利益が減少)
  - 例: 月 ¥10,000 の請求 → 約 ¥400 の手数料
- **実装規模が大きい**: スキーマ変更 (3 テーブル) + サービス層 (~500 行) + Webhook ハンドラ + UI 拡張 + 既存実装 (withMeteredLLM) への配線
- **Stripe 障害時の影響**: Stripe が落ちると Usage Record 送信失敗 → 月末請求金額にズレ (ただし非同期 queue でリカバリ可能)
- **法的要件の整備が必要**: 利用規約に自動更新条項、特定商取引法表記、解約条件を追加。これらは法務確認が必要

### Risk / 留意事項

- **税率変更時**: Stripe Tax が自動追従するが、適格請求書発行事業者番号 (JCT) の有効性は運用で管理
- **Webhook の信頼性**: Stripe の Webhook 配信は 3 日間自動再送だが、それでも失敗するケースに備え `StripeWebhookEvent` テーブルで冪等性保証 + 未処理イベントの監査ダッシュボード追加
- **Stripe API バージョン固定**: `2024-12-18.acacia` を使用、メジャーバージョン更新時は影響範囲調査必須
- **テスト環境の分離**: 本番 Stripe アカウントと Test Mode を `STRIPE_SECRET_KEY` 環境変数で厳密に分離 (= 本番テスト時の誤課金防止)

---

## Alternatives Considered (検討した代替案)

### Alt-1: 自前で決済処理を実装 (= Stripe を使わない)

- **概要**: クレジットカード決済を自社サーバで処理。決済代行業者 (GMO PG, ペイメントゲートウェイ 等) と直接連携
- **メリット**: Stripe 手数料 (3.6%) より低い手数料率の業者を選べる可能性
- **不採用理由**:
  - PCI DSS Level 1 への対応が必要 (= 数百万円〜のコスト)
  - インボイス制度対応・税計算・Subscription 管理・Webhook 受信を全て自前実装 → 開発・保守コストが Stripe 手数料を遥かに上回る
  - 法務リスクが大幅増 (= カード情報漏洩時の損害賠償)

### Alt-2: Komoju / PayJP / Square 等の国内決済プロバイダ

- **概要**: Stripe ではなく日本市場特化の決済プロバイダを採用
- **メリット**:
  - Komoju: コンビニ払い・銀行振込含む幅広い決済手段
  - PayJP: 日本企業運営、サポートが日本語
- **不採用理由**:
  - Metered Billing (使用量ベース自動集計) を **Subscription として実装している** のは Stripe が最も成熟
  - インボイス制度対応の自動化は Stripe Tax が最先端
  - 既存ドキュメント (TENANT_AND_BILLING.md §34.14.8) で Stripe 前提が確定済
  - グローバル展開時 (USD / EUR 対応) の拡張性

### Alt-3: 月固定額 + 超過従量モデル (= 伝統的 SaaS 課金)

- **概要**: Beginner = 無料、Expert = 月¥5,000 + 一定回数以上の超過従量、Pro = 月¥15,000 + 一定回数以上の超過従量
- **メリット**:
  - 月額固定額があれば「使わなくても収入が見込める」 → 売上の予測可能性向上
- **不採用理由**:
  - 既存仕様は **「使った分だけ」のper-call 課金** で確定済 ([TENANT_AND_BILLING.md §34.14](../business/TENANT_AND_BILLING.md))
  - 仕様変更すると既存運用 (PR #371 で確定した請求サイクル) との二重実装が必要
  - 顧客への説明コストが上がる (= 「月額 + 超過」は意味が分かりにくい)

### Alt-4: 都度課金 (= API 呼び出しごとに即時引き落とし)

- **概要**: 各 API 呼び出しで `stripe.paymentIntents.create()` で即時引き落とし
- **メリット**: 月末まで待たず即時に売上確定
- **不採用理由**:
  - **手数料が桁違いに高い**: Stripe は 1 件あたり ¥36 の固定手数料 + 3.6% を取る → 1 回 ¥5 の Haiku 呼び出し (2026-05-15 改定後) に対し ¥36+ の手数料が発生する破綻モデル (改定前 ¥10 でも同様、改定後はさらに不経済)
  - 顧客側のカード明細が「1 件 ¥5 が 300 行」のように激しく汚れる
  - レイテンシ (= LLM 呼び出しに加え Stripe API 待ち) が API 応答速度に影響

### Alt-5: クレジットカード払いの実装を見送り、手動運用継続

- **概要**: 現状 (invoice / bank_transfer) のまま手運用を続け、顧客数が増えてから検討
- **メリット**: 実装コスト 0
- **不採用理由**:
  - 既に 10 件未満想定 → 50 件超えると破綻するため、先行投資する判断
  - 顧客獲得に「クレジットカード払いが使える」というシグナルが効く (= B2B SaaS の競争上必須)
  - 既存ドキュメントで明示的に「v1.x で実装」とコミット済

---

## Related (関連情報)

- 詳細設計: [docs/business/STRIPE_BILLING.md](../business/STRIPE_BILLING.md) (実装前仕様、本 ADR と同時策定)
- 関連 ADR:
  - [ADR-0002: テナント別請求と per-API-call 課金](./0002-tenant-billing-per-api-call.md) (既存課金モデルの根拠)
- 関連 PR:
  - #371: 月途中解約テナントの請求漏れ防止 + 請求サイクル確定 (= 本 ADR の前提となる手動運用フロー)
  - #372: Tenant.suspendedAt による read-only 強制移行 (= 本 ADR の引き落とし失敗時 suspend で再利用)
- 既存ドキュメント:
  - [PAYMENT_TERMS.md](../business/PAYMENT_TERMS.md): 支払い条件と滞納時の取り扱い (本 ADR の決定で §1.1 と §0.2 を更新予定)
  - [TENANT_AND_BILLING.md §34.14.8](../business/TENANT_AND_BILLING.md): v1.x ロードマップでの言及 (本 ADR が実装方針を確定)
  - [PAYMENT_DELINQUENCY_SOP.md](../operations/PAYMENT_DELINQUENCY_SOP.md): 滞納 SOP (本 ADR で §0 入金確認に Webhook 自動検知を追加予定)
  - [BILLING_MONTHLY_OPERATIONS.md](../operations/BILLING_MONTHLY_OPERATIONS.md): 月次請求業務 (本 ADR で credit_card テナントのフローを追加予定)
- 外部参考資料:
  - [Stripe Docs: Metered Billing](https://docs.stripe.com/products-prices/pricing-models#usage-based-pricing)
  - [Stripe Docs: Subscription with Usage Records](https://docs.stripe.com/api/usage_records/create)
  - [Stripe Docs: Smart Retries](https://docs.stripe.com/billing/revenue-recovery/smart-retries)
  - [Stripe Docs: Customer Portal](https://docs.stripe.com/customer-management)
  - [Stripe Docs: Tax (Inbound for Japan)](https://docs.stripe.com/tax)
  - [Stripe Docs: Webhooks (Signature Verification)](https://docs.stripe.com/webhooks/signatures)
