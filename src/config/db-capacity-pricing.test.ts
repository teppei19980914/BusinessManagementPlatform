/**
 * db-capacity-pricing.ts の単体テスト
 *
 * 重要: 誤請求は severity-1 リスクのため、境界値・端数処理を網羅的に検証する。
 * Memory: feedback_billing_invariant.md (ApiCallLog SUM = 請求金額 invariant)
 */

import { describe, it, expect } from 'vitest';
import {
  calculateBillableBytes,
  calculateOverageJpy,
  calculateStripeMeterQuantity,
  classifyDbCapacityLevel,
  SI_MB_BYTES,
  SI_GB_BYTES,
  DB_CAPACITY_FREE_TIER_BYTES,
  DB_CAPACITY_L1_USER_WARNING_BYTES,
  DB_CAPACITY_L2_ADMIN_ALERT_BYTES,
  DB_CAPACITY_L3_HARD_CAP_BYTES,
} from './db-capacity-pricing';

describe('SI 単位定数', () => {
  it('1MB = 10^6 bytes (SI、Supabase 料金体系と整合)', () => {
    expect(SI_MB_BYTES).toBe(1_000_000);
  });

  it('1GB = 10^9 bytes (SI) = 1000MB', () => {
    expect(SI_GB_BYTES).toBe(1_000_000_000);
    expect(SI_GB_BYTES).toBe(1000 * SI_MB_BYTES);
  });

  it('無料枠 = 50MB SI = 50,000,000 bytes', () => {
    expect(DB_CAPACITY_FREE_TIER_BYTES).toBe(50_000_000);
  });

  it('L3 ハードキャップ = 50GB SI = 50,000,000,000 bytes', () => {
    expect(DB_CAPACITY_L3_HARD_CAP_BYTES).toBe(50_000_000_000);
  });
});

describe('calculateBillableBytes', () => {
  it('0 byte → 0', () => {
    expect(calculateBillableBytes(BigInt(0))).toBe(BigInt(0));
  });

  it('無料枠ちょうど (50MB) → 0', () => {
    expect(calculateBillableBytes(BigInt(50 * SI_MB_BYTES))).toBe(BigInt(0));
  });

  it('無料枠未満 (49MB) → 0', () => {
    expect(calculateBillableBytes(BigInt(49 * SI_MB_BYTES))).toBe(BigInt(0));
  });

  it('無料枠 + 1 byte (50MB + 1) → 1', () => {
    expect(calculateBillableBytes(BigInt(50 * SI_MB_BYTES + 1))).toBe(BigInt(1));
  });

  it('51MB → 1MB 分 (1,000,000 bytes)', () => {
    expect(calculateBillableBytes(BigInt(51 * SI_MB_BYTES))).toBe(BigInt(1 * SI_MB_BYTES));
  });

  it('1GB (= 1,000,000,000 bytes) → 950MB 分', () => {
    expect(calculateBillableBytes(BigInt(SI_GB_BYTES))).toBe(BigInt(950 * SI_MB_BYTES));
  });
});

describe('calculateOverageJpy — ADR-0020 §2.2 階段関数型料金', () => {
  describe('無料枠 (0 ~ 50MB) は ¥0', () => {
    it('0 byte → ¥0', () => {
      expect(calculateOverageJpy(BigInt(0))).toBe(0);
    });

    it('10MB → ¥0', () => {
      expect(calculateOverageJpy(BigInt(10 * SI_MB_BYTES))).toBe(0);
    });

    it('50MB ちょうど → ¥0', () => {
      expect(calculateOverageJpy(BigInt(50 * SI_MB_BYTES))).toBe(0);
    });
  });

  describe('Tier 1 (51MB ~ 1,050MB) = ¥50', () => {
    it('50MB + 1 byte → ¥50 (= 1 tier)', () => {
      expect(calculateOverageJpy(BigInt(50 * SI_MB_BYTES + 1))).toBe(50);
    });

    it('51MB → ¥50', () => {
      expect(calculateOverageJpy(BigInt(51 * SI_MB_BYTES))).toBe(50);
    });

    it('100MB → ¥50', () => {
      expect(calculateOverageJpy(BigInt(100 * SI_MB_BYTES))).toBe(50);
    });

    it('500MB → ¥50', () => {
      expect(calculateOverageJpy(BigInt(500 * SI_MB_BYTES))).toBe(50);
    });

    it('1,050MB (tier 1 上限) → ¥50', () => {
      expect(calculateOverageJpy(BigInt(1050 * SI_MB_BYTES))).toBe(50);
    });
  });

  describe('Tier 2 (1,051MB ~ 2,050MB) = ¥100', () => {
    it('1,050MB + 1 byte → ¥100', () => {
      expect(calculateOverageJpy(BigInt(1050 * SI_MB_BYTES + 1))).toBe(100);
    });

    it('1,051MB → ¥100', () => {
      expect(calculateOverageJpy(BigInt(1051 * SI_MB_BYTES))).toBe(100);
    });

    it('2,050MB (tier 2 上限) → ¥100', () => {
      expect(calculateOverageJpy(BigInt(2050 * SI_MB_BYTES))).toBe(100);
    });
  });

  describe('Tier 3+ 連続性', () => {
    it('2,051MB → ¥150 (tier 3)', () => {
      expect(calculateOverageJpy(BigInt(2051 * SI_MB_BYTES))).toBe(150);
    });

    it('10,050MB (= 10.05GB) → ¥500 (tier 10)', () => {
      expect(calculateOverageJpy(BigInt(10050 * SI_MB_BYTES))).toBe(500);
    });

    it('50GB SI (ハードキャップ) → ¥2,500 (tier 50)', () => {
      // 50GB - 50MB = 49,950 MB billable → ceil(49950/1000) = 50 tier → ¥2,500
      expect(calculateOverageJpy(BigInt(50 * SI_GB_BYTES))).toBe(2500);
    });
  });

  describe('端数処理 (1MB 未満は繰上)', () => {
    it('50MB + 1 byte (= 50.000001MB) → 1MB billable → tier 1 = ¥50', () => {
      expect(calculateOverageJpy(BigInt(50 * SI_MB_BYTES + 1))).toBe(50);
    });

    it('50.5MB (= 50,500,000 bytes) → ceil(0.5MB) = 1MB → tier 1 = ¥50', () => {
      expect(calculateOverageJpy(BigInt(50_500_000))).toBe(50);
    });

    it('1,050MB + 500,000 bytes (= 1,050.5MB) → ceil(0.5MB) = 1MB → tier 2 開始 = ¥100', () => {
      expect(calculateOverageJpy(BigInt(1050 * SI_MB_BYTES + 500_000))).toBe(100);
    });
  });
});

describe('calculateStripeMeterQuantity — R6 案 A: quantity = costJpy 整数', () => {
  it('costJpy=50 → quantity=50', () => {
    expect(calculateStripeMeterQuantity(50)).toBe(50);
  });

  it('costJpy=0 → quantity=0', () => {
    expect(calculateStripeMeterQuantity(0)).toBe(0);
  });

  it('負数 → 0 (defensive)', () => {
    expect(calculateStripeMeterQuantity(-10)).toBe(0);
  });

  it('小数 → floor', () => {
    expect(calculateStripeMeterQuantity(50.7)).toBe(50);
  });

  it('ハードキャップ請求額 2500 → quantity=2500', () => {
    expect(calculateStripeMeterQuantity(2500)).toBe(2500);
  });
});

describe('classifyDbCapacityLevel — 4 層防御', () => {
  it('0 byte → none', () => {
    expect(classifyDbCapacityLevel(BigInt(0))).toBe('none');
  });

  it('500MB → none (L1 未満)', () => {
    expect(classifyDbCapacityLevel(BigInt(500 * SI_MB_BYTES))).toBe('none');
  });

  it('1GB ちょうど → l1', () => {
    expect(classifyDbCapacityLevel(BigInt(DB_CAPACITY_L1_USER_WARNING_BYTES))).toBe('l1');
  });

  it('5GB → l1', () => {
    expect(classifyDbCapacityLevel(BigInt(5 * SI_GB_BYTES))).toBe('l1');
  });

  it('10GB ちょうど → l2', () => {
    expect(classifyDbCapacityLevel(BigInt(DB_CAPACITY_L2_ADMIN_ALERT_BYTES))).toBe('l2');
  });

  it('30GB → l2', () => {
    expect(classifyDbCapacityLevel(BigInt(30 * SI_GB_BYTES))).toBe('l2');
  });

  it('50GB ちょうど → l3 (L3 監視アラート閾値到達)', () => {
    expect(classifyDbCapacityLevel(BigInt(DB_CAPACITY_L3_HARD_CAP_BYTES))).toBe('l3');
  });

  it('60GB (over hard cap) → l3', () => {
    expect(classifyDbCapacityLevel(BigInt(60 * SI_GB_BYTES))).toBe('l3');
  });
});

describe('billing invariant — 計算経路の整合性', () => {
  it('calculateOverageJpy → calculateStripeMeterQuantity で値が保たれる (R6 案 A invariant)', () => {
    const peakBytes = BigInt(1234 * SI_MB_BYTES);
    const costJpy = calculateOverageJpy(peakBytes); // 1234 - 50 = 1184 MB → ceil(1184/1000) = 2 tier → ¥100
    expect(costJpy).toBe(100);
    const stripeQuantity = calculateStripeMeterQuantity(costJpy);
    expect(stripeQuantity).toBe(100); // 完全一致 (整数のため丸めロスなし)
  });

  it('境界値 50MB ちょうどでは Stripe Meter quantity = 0 (送信不要)', () => {
    const peakBytes = BigInt(50 * SI_MB_BYTES);
    expect(calculateOverageJpy(peakBytes)).toBe(0);
    expect(calculateStripeMeterQuantity(calculateOverageJpy(peakBytes))).toBe(0);
  });
});
