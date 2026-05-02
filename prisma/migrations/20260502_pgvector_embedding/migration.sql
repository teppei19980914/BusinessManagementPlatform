-- PR #4 / T-03 提案エンジン v2 Phase 2: pgvector + Voyage AI Embedding 基盤
--
-- 目的:
--   1. PostgreSQL の pgvector 拡張を有効化
--   2. 5 つのコンテンツ系エンティティに content_embedding vector(1024) カラム追加
--      - projects / knowledges / risks_issues / retrospectives / memos
--   3. (将来追加) HNSW インデックスは規模が拡大した時点で別 migration で追加
--
-- 設計判断 (詳細は docs/design/SUGGESTION_ENGINE.md / SUGGESTION_ENGINE_PLAN.md PR #4):
--   - Voyage AI voyage-4-lite (1024 次元) を採用 (200M トークン無料、3 系より高品質)
--   - 全カラム NULLABLE (生成失敗時 NULL のまま本体保存を許容、fail-safe)
--   - Backfill は scripts/backfill-embeddings.ts で個別実行 (ダウンタイム回避)
--   - Cosine Similarity 検索は <=> 演算子を使用、HNSW インデックス追加で高速化可
--
-- ロールバック方針:
--   - DROP COLUMN content_embedding は安全 (NULL 許容、本体データに影響なし)
--   - DROP EXTENSION vector は他テーブルが vector 型を使っていなければ可
--   - 本 migration 適用後の embedding データは捨ててよい (再 backfill で再生成可)
--
-- 適用順:
--   Step 1: pgvector 拡張有効化
--   Step 2: 5 エンティティに content_embedding カラム追加

-- ================================================================
-- Step 1: pgvector 拡張有効化
-- ================================================================
-- Supabase / Vercel Postgres / standard PostgreSQL 14+ で利用可能。
-- 拡張がインストールされていない環境では Supabase Dashboard で先に有効化が必要
-- (Supabase は内部的に pgvector を提供しているが、プロジェクト単位で有効化フラグ立てが必要な場合あり)。
CREATE EXTENSION IF NOT EXISTS vector;

-- ================================================================
-- Step 2: 5 エンティティに content_embedding カラム追加
-- ================================================================
-- 既存行は NULL のまま。Backfill は別途 scripts/backfill-embeddings.ts で実行する。

ALTER TABLE "projects" ADD COLUMN "content_embedding" vector(1024);
ALTER TABLE "knowledges" ADD COLUMN "content_embedding" vector(1024);
ALTER TABLE "risks_issues" ADD COLUMN "content_embedding" vector(1024);
ALTER TABLE "retrospectives" ADD COLUMN "content_embedding" vector(1024);
ALTER TABLE "memos" ADD COLUMN "content_embedding" vector(1024);

-- ================================================================
-- (将来追加) HNSW インデックス
-- ================================================================
-- v1 リリース時点ではテナント内データ量が少なく brute-force 検索で十分。
-- 規模拡大時 (例: 1 テナントあたり 1000 件以上の knowledges) で別 migration で追加:
--
--   CREATE INDEX idx_projects_embedding_hnsw ON projects
--     USING hnsw (content_embedding vector_cosine_ops)
--     WHERE content_embedding IS NOT NULL;
--
--   (knowledges / risks_issues / retrospectives / memos も同様)
--
-- HNSW パラメータ (m / ef_construction) はベンチマーク後に決定する。
