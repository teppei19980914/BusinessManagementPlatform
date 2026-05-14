-- 2026-05-14 Supabase Data API 攻撃面遮断 (multi-layer defense)
--
-- 背景:
--   2026-05-11 付の Supabase Security Advisor が `rls_disabled_in_public` で
--   public スキーマの全 37 テーブルを Critical Error として検出。具体的リスク:
--     - Supabase デフォルト privileges により postgres ロールが作成した全テーブルに
--       GRANT ALL TO anon, authenticated, service_role が自動付与される
--     - RLS 無効状態なので anon JWT を提示すれば PostgREST /rest/v1/ から全件
--       read/insert/update/delete 可能 (sessions / password_reset_tokens 含む)
--   本プロジェクトは Prisma 直結のみで Data API (supabase-js / PostgREST) を未使用。
--   Data API の攻撃面は完全に閉じてよい。
--
-- 多層防御の構成:
--   Layer 1 (Dashboard): 2026-05-14 実施済 — Exposed schemas から public を削除 +
--                        Enable Data API を OFF
--   Layer 2 (本 migration): public 全テーブルに ENABLE ROW LEVEL SECURITY
--                            (ポリシー未定義 = anon/authenticated は全操作拒否)
--   Layer 3 (本 migration): anon/authenticated から全 grant を REVOKE +
--                            ALTER DEFAULT PRIVILEGES で将来 migration にも適用
--
-- Prisma 動作への影響:
--   - Prisma は DATABASE_URL の `postgres` ロールで接続 = テーブル owner
--   - PostgreSQL 標準動作で owner は RLS をバイパス (FORCE RLS は使わない)
--   - REVOKE / ALTER DEFAULT は anon/authenticated のみ対象、postgres ロール無影響
--   → アプリ動作・既存テスト 1700+ 件への影響はゼロ
--
-- ローカル DB との互換性:
--   - 本番 (Supabase): anon / authenticated ロールが存在 → Layer 3 適用
--   - ローカル (docker-compose pure PostgreSQL): 同ロール不在 → Layer 3 スキップ
--   - DO ブロックで pg_roles を確認してから REVOKE するため両環境で安全
--
-- べき等性:
--   - ENABLE ROW LEVEL SECURITY: 既に有効でも NO-OP (エラーにならない)
--   - REVOKE / ALTER DEFAULT PRIVILEGES: 再実行 NO-OP
--
-- ロールバック方針:
--   - 必要なら ALTER TABLE ... DISABLE ROW LEVEL SECURITY と GRANT 再付与で復元可
--   - Layer 1 (Dashboard) が有効な限り Data API には到達不可なのでロールバック不要

-- ================================================================
-- Layer 2: public 全テーブルに RLS を有効化
-- ================================================================
-- ポリシー未定義のため anon/authenticated は 0 行しか見えない (完全 deny)。
-- postgres (owner) は RLS バイパスのため Prisma 経由クエリは無影響。

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT schemaname, tablename
    FROM pg_tables
    WHERE schemaname = 'public'
  LOOP
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY;', r.schemaname, r.tablename);
  END LOOP;
END $$;

-- ================================================================
-- Layer 3: anon / authenticated への grant を全 REVOKE + 将来分も自動 REVOKE
-- ================================================================
-- ローカル DB には anon / authenticated ロールが存在しないため、
-- pg_roles で存在確認してから実行する (本番 Supabase でのみ適用される)。
-- service_role は Supabase 内部処理用なので触らない (誤って壊さないため)。

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon;
    REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon;
    ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM anon;
    ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon;
    ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM authenticated;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM authenticated;
    REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM authenticated;
    ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM authenticated;
    ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON SEQUENCES FROM authenticated;
    ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM authenticated;
  END IF;
END $$;
