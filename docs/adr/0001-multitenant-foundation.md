# ADR-0001: マルチテナント基盤を v1 から実装

- **Status**: Accepted
- **Date**: 2026-04-15 (推定、MVP 着手時点)
- **Deciders**: teppei

---

## Context

たすきば Knowledge Relay は当初、社内利用 + 単一テナントでの試験運用から開始する想定だった。
しかし以下の制約から、データ構造を「単一テナント前提」で設計してしまうと、外部公開フェーズ (2026-06-01) で大幅な再設計が必要になることが見えていた。

- **テナント境界の越境は重大な情報漏洩リスク**: 一度マルチテナント化を後付けで導入すると、既存データに `tenantId` を遡及付与する移行が複雑化し、漏洩経路を作る危険が大きい (重要度: severity-1 — 個人情報漏洩相当)
- **外部公開後はテナント単位の課金が必須**: 利用量集計・上限管理・縮退モード判定をすべてテナント軸で行う必要があり、データモデルがテナント境界を持っていないと不可能
- **インフラ移行 (Netlify → AWS) の前提条件**: Supabase の Row Level Security から AWS RDS への移行を視野に入れた場合、アプリケーション層でテナント分離を完結させる方が移行コストが低い

「コードはマルチテナント対応、運用は単一デフォルトテナント」で開始することで、後付けリスクを回避しつつ初期運用負荷を抑える戦略を採れる。

## Decision

**v1 から完全なマルチテナント設計を採用する。**

- 主要エンティティ (Project / User / Knowledge / RiskIssue / Retrospective / Estimate 等) には必ず `tenantId` カラムを持たせる
- すべての一覧系サービスは `viewerTenantId` を必須引数で受け、`where.tenantId` フィルタを強制する (テナント越境防止)
- 認証セッションには `tenantId` を含め、API 層で「ログインユーザの tenantId == リクエスト対象 tenantId」を二段階認可で検証する (詳細は [ADR-0005](./0005-rbac-two-stage-tenant-authorization.md))
- 運用上は **単一デフォルトテナント** で 2026-06-01 公開を行い、外部ユーザ受け入れ準備が整い次第テナント追加運用に切り替える

## Consequences

### Positive
- 外部公開後、テナント追加運用への切り替えがデータ移行なしで可能
- テナント単位の課金・縮退モード・利用量集計が自然に実装できる ([ADR-0002](./0002-tenant-billing-per-api-call.md))
- 越境リスクを「ログイン時点で確定する `tenantId`」で機械的に防げる

### Negative / Trade-off
- 全クエリに `tenantId` フィルタを強制するためサービス層の boilerplate が増える
- セッション認証 → tenant context 確立 → サービス呼び出しの順序が崩れると 500 になりやすく、テストカバレッジが必要
- 開発・テスト時のデータシードがやや煩雑 (テナントを必ず作成してから関連データを作る)

### Risk / 留意事項
- **`where.tenantId` 漏れは事故になる**: 一覧系サービスを新規追加する際、`viewerTenantId` を引数化していないと越境バグになる。これは事故では済まないため、コードレビューで必ず確認する (memory: feedback_tenant_isolation 参照)
- **管理者画面でのテナント横断操作** には `super_admin` ロールを別途設計する必要がある (テナント越境を意図的に許可する例外パス)

## Alternatives Considered

### Alt-1: 単一テナント運用で開始し、外部公開直前にマルチテナント化
- 概要: 初期は `tenantId` を持たず、外部公開時にスキーマ拡張で導入
- メリット: 初期実装が簡素 (`tenantId` フィルタ不要)
- 不採用理由: 既存データへの `tenantId` 遡及付与 + 既存クエリへのフィルタ追加で、データ漏洩経路を作るリスクが極めて高い。本サービスは個人情報・営業情報を扱うため、後付けマルチテナント化は致命的

### Alt-2: PostgreSQL Row Level Security (RLS) で実装
- 概要: アプリ層ではなく DB 層で `tenantId` フィルタを強制 (Supabase が提供)
- メリット: アプリのバグでテナント越境が起きない
- 不採用理由: (1) 将来の AWS RDS 等への移行時に RLS 機構の移植が必要 (2) Prisma との相性が悪く ORM レイヤでの抽象化が難しい (3) サービス層のテスト容易性が低下。**今後の検討対象としては有力** (PHASE 2 で再検討の余地、[docs/security/TENANT_ISOLATION_PHASE2_TODO.md](../security/TENANT_ISOLATION_PHASE2_TODO.md) 参照)

### Alt-3: テナントごとに別 DB スキーマ
- 概要: テナント数だけ schema を切る (`tenant_1`, `tenant_2`, ...)
- メリット: 物理的なデータ分離
- 不採用理由: テナント横断のメトリクス集計 (super_admin 画面) が DB をまたぐ必要があり実装が複雑。バックアップ・マイグレーションも N 倍化

## Related

- 詳細設計: [docs/design/ARCHITECTURE.md](../design/ARCHITECTURE.md) §3.3 / [docs/business/TENANT_AND_BILLING.md](../business/TENANT_AND_BILLING.md) Part 3
- 認可方式: [ADR-0005](./0005-rbac-two-stage-tenant-authorization.md)
- 課金との関係: [ADR-0002](./0002-tenant-billing-per-api-call.md)
- 次フェーズ検討: [docs/security/TENANT_ISOLATION_PHASE2_TODO.md](../security/TENANT_ISOLATION_PHASE2_TODO.md)
