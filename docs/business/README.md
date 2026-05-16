# business/ — ビジネスロジック文書

本ディレクトリは、本サービスの業務ルール・運用フロー・課金モデルなど **ビジネスロジックの中核** を集約する。技術的な実装は [../design/](../design/)、画面の操作仕様は [../specification/](../specification/) を参照。

## ファイル一覧

| ファイル | 内容 | 元の所在 |
|---|---|---|
| [PROJECT_LIFECYCLE.md](./PROJECT_LIFECYCLE.md) | プロジェクト状態定義・状態ごとの操作制限・ロック条件・アカウントライフサイクル | SPECIFICATION.md §2-§3, §8-§10, §10.7, §13 |
| [TENANT_AND_BILLING.md](./TENANT_AND_BILLING.md) | マルチテナント運用フロー・3 プラン構成 (Beginner/Expert/Pro)・per-API-call 従量課金・月次予算上限 | DESIGN.md §34.11-§34.14 + REQUIREMENTS.md §13.6-§13.7 + SPECIFICATION.md §26.6-§26.7 |
| [PAYMENT_TERMS.md](./PAYMENT_TERMS.md) | 請求書 / 銀行振込支払いの期日条件と滞納時の対外ルール (フェーズ 1〜4 / read-only 化 / 削除条件) | 新規 (2026-05-09) |
| [STRIPE_BILLING.md](./STRIPE_BILLING.md) | Stripe Metered Billing 連携によるクレジットカード自動引き落とし仕様 (v1.x で実装予定) | 新規 (2026-05-14) |
| [USER_ROLES.md](./USER_ROLES.md) | システムロール (admin / general)・プロジェクトロール (pm_tl / member / viewer) の定義と権限制御方針 | SPECIFICATION.md §6 |
| [MVP_SCOPE.md](./MVP_SCOPE.md) | MVP 必須機能一覧・対象外機能・管理項目一覧・要件定義全体 | REQUIREMENTS.md §1-§12 + SPECIFICATION.md §4-§5 |
| [GLOSSARY.md](./GLOSSARY.md) | 業務用語辞書 (プロジェクト/テナント/プラン/提案エンジン/ロール 等の正式名と意味) | 新規 (2026-05-14) |
| [FEATURE_CATALOG.md](./FEATURE_CATALOG.md) | 機能カタログ (7 カテゴリ × 機能 × 顧客課題 × 主な変更先ファイル のマトリクス、顧客 FB トリアージ用) | 新規 (2026-05-16) |

---

## 横断索引: Stripe / 課金関連

Stripe / 課金は複数ディレクトリにまたがる。role-based に分散している分、本マトリクスで一覧する。

| 観点 | ファイル | 内容 |
|---|---|---|
| **ビジネスルール** | [TENANT_AND_BILLING.md](./TENANT_AND_BILLING.md) | per-API-call 従量課金モデル、3 プラン構成、月次予算上限 |
| **ビジネスルール** | [PAYMENT_TERMS.md](./PAYMENT_TERMS.md) | 請求書 / 銀行振込の期日・滞納時取扱い |
| **ビジネスルール** | [STRIPE_BILLING.md](./STRIPE_BILLING.md) | Stripe Metered Billing 連携仕様 (v1.x) |
| **UI 仕様** | [../specification/STRIPE_PAYMENT_UI.md](../specification/STRIPE_PAYMENT_UI.md) | クレジットカード払い UI 仕様 |
| **技術設計** | [../design/STRIPE_TECHNICAL_DESIGN.md](../design/STRIPE_TECHNICAL_DESIGN.md) | Stripe Metered Billing 詳細技術設計 |
| **運用手順** | [../operations/STRIPE_SETUP.md](../operations/STRIPE_SETUP.md) | Stripe Dashboard セットアップ |
| **運用手順** | [../operations/BILLING_MONTHLY_OPERATIONS.md](../operations/BILLING_MONTHLY_OPERATIONS.md) | 月次請求業務 |
| **運用手順** | [../operations/PAYMENT_DELINQUENCY_SOP.md](../operations/PAYMENT_DELINQUENCY_SOP.md) | 滞納時 SOP |
| **実装計画** | [../roadmap/STRIPE_INTEGRATION_PLAN.md](../roadmap/STRIPE_INTEGRATION_PLAN.md) | v1.x 実装ロードマップ |
| **設計判断** | [../adr/0002-tenant-billing-per-api-call.md](../adr/0002-tenant-billing-per-api-call.md) | per-API-call 採用理由 |
| **設計判断** | [../adr/0006-stripe-metered-billing-integration.md](../adr/0006-stripe-metered-billing-integration.md) | Stripe 採用理由 |
| **設計判断** | [../adr/0007-unify-invoice-and-bank-transfer.md](../adr/0007-unify-invoice-and-bank-transfer.md) | invoice/bank_transfer 統合 |
| **設計判断** | [../adr/0013-beginner-downgrade-prohibition.md](../adr/0013-beginner-downgrade-prohibition.md) | Beginner ダウングレード禁止 |

---

## 横断索引: 提案エンジン関連

提案エンジン (核心機能) も複数ディレクトリにまたがる。

| 観点 | ファイル | 内容 |
|---|---|---|
| **機能仕様** | [../specification/SUGGESTION_FEATURE.md](../specification/SUGGESTION_FEATURE.md) | 機能仕様 + コスト構造 |
| **技術設計** | [../design/SUGGESTION_ENGINE.md](../design/SUGGESTION_ENGINE.md) | v1 + v2 の技術設計全体 |
| **脅威モデル** | [../security/SUGGESTION_ENGINE_THREAT_MODEL.md](../security/SUGGESTION_ENGINE_THREAT_MODEL.md) | STRIDE 脅威分析 |
| **運用検証** | [../operations/SUGGESTION_ENGINE_VERIFICATION.md](../operations/SUGGESTION_ENGINE_VERIFICATION.md) | v2 改修効果の検証記録 |
| **リリースノート** | [../operations/T-03_RELEASE_NOTES.md](../operations/T-03_RELEASE_NOTES.md) | T-03 リリースノート |
| **実装計画** | [../roadmap/SUGGESTION_ENGINE_PLAN.md](../roadmap/SUGGESTION_ENGINE_PLAN.md) | T-03 実装ロードマップ |
| **設計判断** | [../adr/0003-embedding-based-suggestion-engine.md](../adr/0003-embedding-based-suggestion-engine.md) | Embedding ベース採用理由 |
| **設計判断** | [../adr/0008-graceful-degradation-mode.md](../adr/0008-graceful-degradation-mode.md) | 縮退モード採用理由 |
| **v2 構想 (将来)** | [../roadmap/future/CHAT_SEMANTIC_SEARCH.md](../roadmap/future/CHAT_SEMANTIC_SEARCH.md) | チャットボット意味検索 (v2 以降) |
