# ADR (Architecture Decision Record)

本ディレクトリは、たすきば Knowledge Relay の **主要な設計判断** を時系列で記録します。
「なぜこの設計にしたのか」「他にどんな選択肢があり、なぜ採用しなかったのか」を残すことで、
将来の機能追加や設計変更の意思決定を支援します。

---

## なぜ ADR を書くのか

- **後戻りコストの高い決定を明示する**: 「採用したライブラリ」「データモデルの根本構造」「課金方式」等は、変更すると影響が広範に及ぶ。判断の根拠を残すことで、安易な変更を防ぐ
- **代替案の検討経緯を残す**: 「なぜ A ではなく B にしたか」を残さないと、後から「A の方が良かったのでは」という疑問が再燃する
- **コードや仕様書だけでは伝わらない「制約・前提」を残す**: 設計書には「どう作るか」、ADR には「なぜそう作るか」が書かれる

---

## ADR の索引

| # | タイトル | Status | 関連分野 |
|---|---|---|---|
| [0001](./0001-multitenant-foundation.md) | マルチテナント基盤を v1 から実装 | Accepted | アーキテクチャ・セキュリティ |
| [0002](./0002-tenant-billing-per-api-call.md) | テナント単位の従量課金モデル (per-API-call) | Accepted | ビジネス・課金 |
| [0003](./0003-embedding-based-suggestion-engine.md) | Embedding ベース意味検索を提案エンジンに採用 | Accepted | 核心機能 |
| [0004](./0004-postgresql-prisma.md) | PostgreSQL 16 + Prisma ORM の採用 | Accepted | データ基盤 |
| [0005](./0005-rbac-two-stage-tenant-authorization.md) | RBAC + 二段階テナント認可 (Service 層で統一) | Accepted | セキュリティ |
| [0006](./0006-stripe-metered-billing-integration.md) | Stripe Metered Billing 連携によるクレジットカード自動引き落とし (v1.x) | Accepted | ビジネス・課金 |
| [0007](./0007-unify-invoice-and-bank-transfer.md) | `invoice` と `bank_transfer` の支払い方法を統合 (UI ラベル「銀行振込」, 内部値 `invoice`) | Accepted | ビジネス・課金 |
| [0008](./0008-graceful-degradation-mode.md) | 縮退モード (graceful degradation) — ハードカット 429 を採用しない | Accepted | 課金・UX |
| [0009](./0009-nextauth-credentials-mfa-totp.md) | NextAuth.js (Credentials) + MFA (TOTP) を認証基盤に採用 | Accepted | セキュリティ・認証 |
| [0010](./0010-project-state-machine.md) | プロジェクト状態マシン (7 状態 + 一方向遷移) を業務ロジックの中核 | Accepted | 業務ロジック |
| [0011](./0011-soft-delete-and-audit-log.md) | 論理削除 (soft delete) + 全変更操作の監査ログ完全記録 | Accepted | データ管理・セキュリティ |
| [0012](./0012-vercel-supabase-mvp-hosting.md) | Vercel + Supabase 無料枠を MVP 期のインフラに採用 (AWS 移行を視野) | Accepted | インフラ |
| [0013](./0013-beginner-downgrade-prohibition.md) | Beginner プランへのダウングレード禁止 (悪用防止ルール) | Accepted | ビジネス・課金 |
| [0014](./0014-crud-permission-redesign.md) | CRUD 設計刷新 — UI=API 認可一致原則 + PM/TL 自律権限 + 自己ロール変更禁止 (2026-05-20 採択) | Accepted | セキュリティ・業務ロジック |
| [0015](./0015-cascade-delete-idempotent-design.md) | deleteProjectCascade / deleteCustomerCascade の冪等設計 + 段階別 transaction (2026-05-20 採択) | Accepted | データ管理・運用 |
| [0016](./0016-multi-tenant-user-membership.md) | User.email を tenant-scoped 一意化 + 組織 ID 明示入力 (2026-05-20 採択) | Accepted | アーキテクチャ・認証 |
| [0017](./0017-wbs-import-uplift-and-task-duplicate.md) | WBS sync-import 親スコープ重複判定 + OCC + DB UNIQUE + 一括複製 + ログイン UX (2026-05-25 採択 / PR #420) | Accepted | 業務ロジック・UX・データ管理 |

> 主要設計判断を時系列で ADR 化しています (現在 17 件)。
> 設計変更を検討する際は新規 ADR を追加し、変更が確定したら旧 ADR の Status を Deprecated / Superseded に更新します。

---

## 新しい ADR を書くとき

### いつ書くか

以下に該当する判断は ADR 化する:

- **採用したライブラリ / SaaS / フレームワーク** の選定理由 (代替案を持つ場合)
- **データモデルの根本構造** や **認可方式** など、後戻りコストが高い設計
- **業務ロジックの中核** (例: 課金方式、ロール体系、状態遷移ルール)
- **「これは別案があったが、特定の理由でこの方式にした」と説明したくなる設計**

### 書き方

1. 連番で新規ファイルを作成: `NNNN-kebab-case-title.md` (例: `0006-cache-strategy.md`)
2. [TEMPLATE.md](./TEMPLATE.md) をコピーして内容を埋める
3. 本 README.md の索引表に 1 行追加
4. PR で他メンバーのレビューを受ける (重要決定は必ず複数人で確認)

### Status の使い分け

- **Proposed**: 提案段階。議論中
- **Accepted**: 採用決定 (= 実装に着手 or 既に実装済み)
- **Deprecated**: 別の判断に置き換えられた。新規 ADR から「Supersedes ADR-XXXX」で参照
- **Superseded by ADR-YYYY**: 古い決定。新しい ADR へのリンクを残す
