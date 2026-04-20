-- PR #72: ユーザ画面テーマ設定。既定 'light' (ライトテーマ)。
-- セッションを閉じても永続するようにユーザテーブルに保持する
-- (sessionStorage だとブラウザ/タブを閉じた時点で消えてしまうため DB に持つ)。
ALTER TABLE "users"
  ADD COLUMN "theme_preference" VARCHAR(30) NOT NULL DEFAULT 'light';
