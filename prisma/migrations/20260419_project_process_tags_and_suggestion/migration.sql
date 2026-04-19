-- PR #65 Phase 1: 核心機能 (提案型サービス) 実装のための準備
-- 1. Project に processTags 列を追加 (Knowledge と同じ粒度で工程タグを持たせる)
-- 2. pg_trgm 拡張を有効化 (テキスト類似度計算のため)
-- 3. 類似度計算で参照する主要テキスト列に GIN (pg_trgm) インデックスを作成

-- 1. Project.processTags: 新規プロジェクト作成時のタグ交差マッチングに使用
ALTER TABLE "projects"
  ADD COLUMN "process_tags" JSONB NOT NULL DEFAULT '[]';

-- 2. pg_trgm 拡張: trigram ベースのテキスト類似度を計算するため
-- Supabase では superuser 権限で実行可能。既に有効な場合は IF NOT EXISTS でスキップ。
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 3. Knowledge の主要テキストにトライグラム GIN インデックス
-- Project の purpose/scope/background と similarity() で比較する際の性能確保
CREATE INDEX IF NOT EXISTS "idx_knowledges_title_trgm"
  ON "knowledges" USING GIN ("title" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "idx_knowledges_content_trgm"
  ON "knowledges" USING GIN ("content" gin_trgm_ops);

-- 4. RiskIssue (過去課題) の主要テキストにもトライグラム GIN インデックス
-- type='issue' + state='resolved' を過去資産として雛形複製する用途
CREATE INDEX IF NOT EXISTS "idx_risks_issues_title_trgm"
  ON "risks_issues" USING GIN ("title" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "idx_risks_issues_content_trgm"
  ON "risks_issues" USING GIN ("content" gin_trgm_ops);

-- 5. PR #65 Phase 2 (b): Knowledge.businessDomainTags を追加
-- Project.businessDomainTags と対称化し、Jaccard 類似度で業務ドメイン軸もマッチ
ALTER TABLE "knowledges"
  ADD COLUMN IF NOT EXISTS "business_domain_tags" JSONB NOT NULL DEFAULT '[]';

-- 6. PR #65 Phase 2 (a): 過去振り返り (problems / improvements) のトライグラム GIN インデックス
-- 新プロジェクトの purpose / background / scope と類似度計算する用途
CREATE INDEX IF NOT EXISTS "idx_retrospectives_problems_trgm"
  ON "retrospectives" USING GIN ("problems" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "idx_retrospectives_improvements_trgm"
  ON "retrospectives" USING GIN ("improvements" gin_trgm_ops);
