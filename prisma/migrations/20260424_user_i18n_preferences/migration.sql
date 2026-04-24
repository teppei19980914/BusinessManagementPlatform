-- PR #118 (2026-04-24): ユーザ個別の i18n 設定 (タイムゾーン / ロケール)。
--
-- 設計:
--   - null = システムデフォルト (env APP_DEFAULT_TIMEZONE / APP_DEFAULT_LOCALE or
--     src/config/i18n.ts の FALLBACK 値) を使用する、という意味。
--   - DB は常に UTC (既存 timestamptz カラム) で格納し、描画時にこの値を
--     Intl.DateTimeFormat に渡して表示形式を解決する。
--   - IANA タイムゾーン最長は 'America/Argentina/ComodRivadavia' (32 文字) 程度。
--     将来の拡張余地を見て VARCHAR(60) とする。
--   - BCP 47 ロケールは 'zh-Hant-HK' 等で最長 10 文字前後。VARCHAR(10) で十分。
--
-- 既存ユーザへの影響:
--   NULL 許容で DEFAULT なし → 全既存行は NULL のまま → システムデフォルト参照。
--   挙動は PR #117 の JST 固定と同等 (config の FALLBACK が 'Asia/Tokyo' のため)。
ALTER TABLE "users"
  ADD COLUMN "timezone" VARCHAR(60),
  ADD COLUMN "locale"   VARCHAR(10);
