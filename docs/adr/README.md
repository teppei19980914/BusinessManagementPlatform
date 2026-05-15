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

> 16 件の主要設計判断のうち、影響範囲が最も広い 6 件を ADR 化しています。
> 未 ADR 化の判断 (例: NextAuth + MFA、Vercel + Supabase、論理削除、プロジェクト状態マシン、縮退モード設計 等) は、設計変更を検討する際に都度 ADR 化します。

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
