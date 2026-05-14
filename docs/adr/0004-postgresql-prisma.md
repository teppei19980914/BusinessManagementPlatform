# ADR-0004: PostgreSQL 16 + Prisma ORM の採用

- **Status**: Accepted
- **Date**: 2026-04-15 (MVP 着手時点)
- **Deciders**: teppei

---

## Context

データ基盤の選定は、後戻りコストが最も高い設計判断の一つ。
本サービスのデータモデルには以下の特性がある:

- **関係的データが主**: プロジェクト・ユーザ・タスク・ナレッジ等が複雑に関連付く (リレーショナル DB が自然)
- **JSONB の利便性が必要**: 提案エンジンのメタデータ、監査ログ、設定値など「スキーマレスでも扱いたい」フィールドがある
- **ベクトル検索が必須**: 提案エンジンのために embedding ベクトルを格納・類似度検索する必要がある ([ADR-0003](./0003-embedding-based-suggestion-engine.md))
- **全文検索もそこそこ必要**: ベクトル検索が主だが、補助的にキーワード検索も欲しい (`tsvector`)
- **マイグレーション管理が頻繁**: 開発初期はスキーマ変更が多発する
- **将来の AWS RDS / Azure Database for PostgreSQL 等への移行を視野に**: Supabase で開始し、規模拡大時に移行できる必要がある

開発体制の制約:

- **TypeScript フルスタック (Next.js)**: フロント・バックエンドで同じ型定義を共有したい
- **個人/少人数開発**: 開発効率が極めて重要、boilerplate を最小化したい
- **テストカバレッジ確保**: ユニットテスト・統合テストでの DB アクセス容易性が必要

## Decision

**PostgreSQL 16 (Supabase 提供) + Prisma ORM** を採用する。

- DB: PostgreSQL 16 (Supabase 無料枠で開始、運用拡大時は AWS RDS 等への移行を視野)
- ORM: Prisma 6.x (型生成、マイグレーション管理、クエリビルダー)
- 拡張機能: pgvector (ベクトル検索)、`pg_trgm` (補助全文検索)、PostgREST は使用せず
- 接続: Prisma の `pg-adapter` 経由 (将来の DB プロバイダ変更を容易化)

## Consequences

### Positive
- **型安全**: schema.prisma から TypeScript 型が自動生成され、フロント/バック共通で使える
- **マイグレーション履歴の追跡**: `prisma/migrations/` でスキーマ変更が時系列管理される
- **JSONB / ベクトル / 全文検索が 1 DB で完結**: 別 vector DB や別 search engine を立てる必要がない (運用負荷低)
- **Supabase 無料枠で MVP 期は ¥0 運用可能**: 初期コストを最小化、規模拡大時に従量課金へ自然移行
- **エコシステム**: Prisma Studio で GUI 確認、Next.js との相性が良い、コミュニティが大きい

### Negative / Trade-off
- **Prisma のパフォーマンス限界**: 大規模クエリ・複雑な JOIN ではパフォーマンスが劣化することがある。N+1 やバッチ化漏れが起きやすく、コードレビューでチェックが必要 (memory: feedback_perf_antipatterns)
- **マイグレーションの罠**: 命名順 (アルファベット順実行) と冪等化が必要 ([docs/operations/DB_MIGRATION_PROCEDURE.md](../operations/DB_MIGRATION_PROCEDURE.md))
- **Client Component への value import で build 失敗**: Prisma が client bundle に混入すると Vercel build が壊れる罠 (memory: feedback_client_service_boundary)
- **マイグレーション数の累積**: MVP 開発中だけで 48 個 (2026-05-11 時点)。リリース前に init 系を squash する余地あり

### Risk / 留意事項
- **AWS RDS への移行時の互換性**: Supabase 固有機能 (RLS, Realtime, Edge Functions) は使わない方針。pgvector / `pg_trgm` は AWS RDS for PostgreSQL でも利用可能
- **接続プールのチューニング**: Vercel のサーバレス環境では「接続枯渇」が起きやすい。Supabase Pooler 経由で接続管理 ([docs/operations/ENV_VARS.md](../operations/ENV_VARS.md) 参照)
- **マイグレーション復旧手順**: `scripts/recover-prisma-migrations.ts` で復旧手順を準備済み

## Alternatives Considered

### Alt-1: MongoDB (NoSQL)
- 概要: ドキュメント指向の NoSQL DB
- メリット: スキーマレスで初期の柔軟性が高い、JSON 構造との親和性
- 不採用理由: (1) 関係的データの結合クエリが弱い (本サービスはプロジェクト⇔タスク⇔ナレッジが複雑に結合) (2) ベクトル検索は Atlas Search で別料金 (3) Vercel との連携で枯れた選択肢にならない (4) 型安全性が ORM 経由でも弱い

### Alt-2: PlanetScale (MySQL ベース)
- 概要: サーバレス MySQL、ブランチング DB
- メリット: ブランチ単位でのスキーマ変更検証ができる
- 不採用理由: (1) JSONB がない (MySQL の JSON 型は機能が弱い) (2) pgvector 相当がない (3) 無料枠が PostgreSQL より制限的

### Alt-3: Supabase + Drizzle ORM
- 概要: Drizzle は TypeScript ファースト ORM
- メリット: Prisma より軽量、生 SQL 寄りで自由度が高い
- 不採用理由: (1) Prisma の方がエコシステム成熟度が高く、学習リソースが豊富 (2) 個人/少人数開発では Prisma のスキーマファースト + 自動マイグレーションの方が開発効率が高い (3) Drizzle は 2026 年時点でも relatively new

### Alt-4: 生 SQL + node-postgres (ORM 不使用)
- 概要: SQL を直接書く
- メリット: 最大のパフォーマンス自由度
- 不採用理由: 型安全性とマイグレーション管理を自前で実装する負荷が大きい。個人開発では維持しきれない

## Related

- 詳細設計: [docs/design/ARCHITECTURE.md](../design/ARCHITECTURE.md) §2.2 / [docs/design/DATA_MODEL.md](../design/DATA_MODEL.md) (全節)
- マイグレーション手順: [docs/operations/DB_MIGRATION_PROCEDURE.md](../operations/DB_MIGRATION_PROCEDURE.md)
- インフラ構成: [docs/design/INFRASTRUCTURE.md](../design/INFRASTRUCTURE.md)
- AWS 移行計画: [docs/operations/MIGRATION_TO_AWS.md](../operations/MIGRATION_TO_AWS.md)
- ベクトル検索の採用: [ADR-0003](./0003-embedding-based-suggestion-engine.md)
- 関連 KDD: マイグレーション命名規約 + 冪等化規約 ([docs/developer-guide/REFERENCE.md](../developer-guide/REFERENCE.md) §5.68)
