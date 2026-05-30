-- ADR-0028 (2026-05-30): たすきフクロウ AI ヘルプチャット RAG 検索基盤
--
-- 背景:
--   ADR-0027 で実装した full-context 方式は FAQ 拡張時 (50→300 件等) にトークン
--   コストが線形増大する課題があった。Voyage AI + pgvector 既存基盤を流用した
--   RAG (Retrieval-Augmented Generation) に切り替え、コスト固定 + FAQ 拡張耐性
--   を実現する。
--
-- 設計判断:
--   - **既存資産流用**: chat-search.service.ts の pgvectorSearch パターン /
--     embedding.service.ts の generateBatchEmbeddings / voyage-client.ts を
--     そのまま再利用 (feedback_reuse_existing_design_first)。
--   - **テナント横断**: FAQ 本文はサービス全体共有 (source-of-truth は
--     src/config/faq-content.ts / guide-content.ts)。tenant_id を持たない。
--   - **権限デノーマライズ**: requires_admin / requires_project_pm を denormalize
--     して SQL 段で top-K を権限フィルタする。defense-in-depth で TS 側でも
--     getFaqEntriesForRole(viewer) を再適用 (★severity-1★ 情報漏洩防止)。
--   - **drift 検知**: content_hash (SHA-256 of question+answer+keywords) を保持し
--     scripts/check-faq-embeddings-sync.ts が CI で config vs DB を突合。
--     ★生命線★ 4 層防御の 1 つ。
--   - **content_snapshot**: deploy 直後の config と DB 乖離瞬間でも回答品質維持。
--     source-of-truth はあくまで src/config (deploy 後に generate スクリプト実行)。
--   - **NOT NULL embedding**: 生成失敗時は row を作らない (= row 存在 = 生成完了の証跡)。
--
-- ロールバック方針:
--   - DROP TABLE は安全 (RAG 検索が動かなくなるだけ、本体機能は影響なし)
--   - 再生成は scripts/generate-faq-embeddings.ts で復旧可
--
-- ============================================================
-- 1. FAQ embeddings テーブル
-- ============================================================
CREATE TABLE "faq_embeddings" (
  "id"                  UUID         NOT NULL DEFAULT gen_random_uuid(),
  "entry_id"            VARCHAR(150) NOT NULL,
  "content_hash"        VARCHAR(64)  NOT NULL,
  "content_snapshot"    TEXT         NOT NULL,
  "content_embedding"   vector(1024) NOT NULL,
  "requires_admin"      BOOLEAN      NOT NULL DEFAULT false,
  "requires_project_pm" BOOLEAN      NOT NULL DEFAULT false,
  "category"            VARCHAR(50)  NOT NULL,
  "generated_at"        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  "created_at"          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  "updated_at"          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT "faq_embeddings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "faq_embeddings_entry_id_key"
  ON "faq_embeddings"("entry_id");

CREATE INDEX "idx_faq_embeddings_category"
  ON "faq_embeddings"("category");

CREATE INDEX "idx_faq_embeddings_permission"
  ON "faq_embeddings"("requires_admin", "requires_project_pm");

-- ============================================================
-- 2. Guide embeddings テーブル
-- ============================================================
CREATE TABLE "guide_embeddings" (
  "id"                  UUID         NOT NULL DEFAULT gen_random_uuid(),
  "entry_id"            VARCHAR(150) NOT NULL,
  "content_hash"        VARCHAR(64)  NOT NULL,
  "content_snapshot"    TEXT         NOT NULL,
  "content_embedding"   vector(1024) NOT NULL,
  "requires_admin"      BOOLEAN      NOT NULL DEFAULT false,
  "requires_project_pm" BOOLEAN      NOT NULL DEFAULT false,
  "step_order"          INTEGER      NOT NULL,
  "generated_at"        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  "created_at"          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  "updated_at"          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT "guide_embeddings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "guide_embeddings_entry_id_key"
  ON "guide_embeddings"("entry_id");

CREATE INDEX "idx_guide_embeddings_step_order"
  ON "guide_embeddings"("step_order");

CREATE INDEX "idx_guide_embeddings_permission"
  ON "guide_embeddings"("requires_admin", "requires_project_pm");

-- ============================================================
-- 3. (将来追加) HNSW インデックス
-- ============================================================
-- FAQ/Guide は数十〜数百件規模で brute-force Cosine で十分。
-- 1000 件超 (海外展開で多言語化等) に到達したら以下を別 migration で追加:
--
--   CREATE INDEX idx_faq_embeddings_hnsw ON faq_embeddings
--     USING hnsw (content_embedding vector_cosine_ops);
--   CREATE INDEX idx_guide_embeddings_hnsw ON guide_embeddings
--     USING hnsw (content_embedding vector_cosine_ops);
