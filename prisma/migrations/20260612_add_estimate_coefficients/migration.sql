-- 工数見積もりツール v1.2.0: 係数ベース見積もり列の追加
--
-- input_mode: 入力モード ('direct' = 手動入力, 'coefficient' = 係数ベース)
--   既存レコードはすべて 'direct' として扱う (デフォルト値でデータ損失なし)
-- base_hours:        係数モード時の基準時間 (h)
-- scale_coeff:       規模係数 (極小0.3 〜 特大2.5)
-- difficulty_coeff:  難易度係数 (低0.8 〜 非常に高1.8)
-- method_coeff:      手法係数 (ツール選択時は基準時間主体のため基本1.0)
--
-- 計算式: 見積工数 = base_hours × scale_coeff × difficulty_coeff × method_coeff

ALTER TABLE "estimates" ADD COLUMN "input_mode"        VARCHAR(20)   NOT NULL DEFAULT 'direct';
ALTER TABLE "estimates" ADD COLUMN "base_hours"        DECIMAL(10,2);
ALTER TABLE "estimates" ADD COLUMN "scale_coeff"       DECIMAL(5,2);
ALTER TABLE "estimates" ADD COLUMN "difficulty_coeff"  DECIMAL(5,2);
ALTER TABLE "estimates" ADD COLUMN "method_coeff"      DECIMAL(5,2);
