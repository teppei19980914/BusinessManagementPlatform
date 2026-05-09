-- 2026-05-09 (PR C / #5 #8 #10): 請求先情報の個人/法人分岐 + 住所サブフィールド化
--
-- 追加する列 (すべて NULL OK = 既存テナント互換):
--   - billing_type           : 'corporate' | 'individual' (default 'corporate' で後方互換)
--   - billing_postal_code    : 郵便番号 (例 '100-0001')
--   - billing_prefecture     : 都道府県 (例 '東京都')
--   - billing_city           : 市区町村 (例 '千代田区')
--   - billing_street_address : 番地・町名 (例 '千代田1-1')
--   - billing_building_name  : 建物名・部屋番号 (#10: optional)
--
-- 既存 billing_address (Text) は legacy として残す:
--   - 既存テナントの過去入力データを失わないため
--   - UI からは編集しない / 表示はフォールバック (新フィールド未設定時のみ)
--   - 将来 (90 日 grace 終了 + 全テナント移行確認後) に DROP 予定
--
-- べき等性: 全 ALTER で IF NOT EXISTS。再実行で失敗しない (P-G migration の方針踏襲)。

ALTER TABLE "tenants"
  ADD COLUMN IF NOT EXISTS "billing_type"           VARCHAR(20)  NOT NULL DEFAULT 'corporate',
  ADD COLUMN IF NOT EXISTS "billing_postal_code"    VARCHAR(10),
  ADD COLUMN IF NOT EXISTS "billing_prefecture"     VARCHAR(20),
  ADD COLUMN IF NOT EXISTS "billing_city"           VARCHAR(100),
  ADD COLUMN IF NOT EXISTS "billing_street_address" VARCHAR(200),
  ADD COLUMN IF NOT EXISTS "billing_building_name"  VARCHAR(200);

COMMENT ON COLUMN "tenants"."billing_type"           IS '請求先種別。corporate=法人 / individual=個人 (#5)';
COMMENT ON COLUMN "tenants"."billing_postal_code"    IS '郵便番号 (例 100-0001)。#8 で構造化';
COMMENT ON COLUMN "tenants"."billing_prefecture"     IS '都道府県。#8 で構造化';
COMMENT ON COLUMN "tenants"."billing_city"           IS '市区町村。#8 で構造化';
COMMENT ON COLUMN "tenants"."billing_street_address" IS '番地・町名。#8 で構造化';
COMMENT ON COLUMN "tenants"."billing_building_name"  IS '建物名・部屋番号 (任意 #10)';
COMMENT ON COLUMN "tenants"."billing_address"        IS 'Legacy: 旧 単一 Text 住所。新規入力はサブフィールドに。フォールバック表示用に残置';
