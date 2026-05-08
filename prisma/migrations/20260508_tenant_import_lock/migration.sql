-- P-D (2026-05-08): テナント別データ一括インポートの二重実行防止フラグを Tenant に追加
--
-- 目的:
--   - データインポート進行中は同テナントへの追加インポートを拒否する (in-flight ロック)
--   - クラッシュ等で残留した古いロックは「閾値時間 (例 30 分) 経過で自動失効」扱いにする
--     ためタイムスタンプ型 (Boolean ではない) で管理する
--
-- 利用パターン:
--   - インポート開始時: importInProgressAt = NOW() を SET
--   - インポート完了/失敗時: importInProgressAt = NULL に CLEAR
--   - 開始時チェック: importInProgressAt が NULL もしくは閾値時間以上経過 → 取得可能
--
-- 詳細仕様: docs/roadmap/V1_FINAL_TASKS.md P-D
-- 関連: src/services/data-import.service.ts (インポート本体)

ALTER TABLE "tenants"
  ADD COLUMN "import_in_progress_at" TIMESTAMPTZ;
