-- 2026-06-29 v1.5.0: アイデアツール (投票・ホワイトボード・匿名FAQ) への embedding カラム追加
--
-- 目的:
--   プロジェクト詳細画面に「PJ内から探す」タブ (たすきフクロウのプロジェクトスコープ検索) を追加するため、
--   アイデアツールの3モデルに content_embedding vector(1024) を追加する。
--
-- 設計判断:
--   - embedding 生成タイミング: 各セッション/スレッドのクローズ時のみ (1 クローズ = 1 Voyage API 呼び出し)。
--     アクティブ中は検索対象外 (= keyword search で代替)。クローズ後の追加回答は re-embedding しない。
--   - 全カラム NULLABLE (生成失敗時 NULL のまま保存を許容、fail-safe)。
--   - 既存のクローズ済みデータは scripts/backfill-idea-embeddings.ts で一括生成 (EMBEDDING_BACKFILL 扱い)。
--   - pgvector 拡張は 20260502_pgvector_embedding migration で既に有効化済み。
--
-- 課金:
--   - featureUnit: idea-qa-embedding / idea-whiteboard-embedding / idea-voting-embedding
--   - Beginner: ¥0、Expert/Pro: ¥5/call (ADR-0029 単価改定後)
--
-- ロールバック:
--   ALTER TABLE "idea_voting_sessions" DROP COLUMN "content_embedding";
--   ALTER TABLE "idea_whiteboard_sessions" DROP COLUMN "content_embedding";
--   ALTER TABLE "idea_qa_threads" DROP COLUMN "content_embedding";

ALTER TABLE "idea_voting_sessions" ADD COLUMN "content_embedding" vector(1024);
ALTER TABLE "idea_whiteboard_sessions" ADD COLUMN "content_embedding" vector(1024);
ALTER TABLE "idea_qa_threads" ADD COLUMN "content_embedding" vector(1024);
