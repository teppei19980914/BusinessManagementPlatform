/**
 * Tests for src/config/billing.ts (PR-V7a)
 */

import { describe, it, expect } from 'vitest';
import {
  TAX_RATE,
  calculateTaxJpy,
  calculateInvoiceDueDate,
  isOverdue,
  OVERDUE_ALERT_THRESHOLD_DAYS,
} from './billing';

describe('billing config', () => {
  describe('TAX_RATE', () => {
    it('is 10%', () => {
      expect(TAX_RATE).toBe(0.10);
    });
  });

  describe('calculateTaxJpy', () => {
    it('returns ¥0 for ¥0', () => {
      expect(calculateTaxJpy(0)).toBe(0);
    });

    it('returns ¥150 for ¥1500 (no rounding needed)', () => {
      expect(calculateTaxJpy(1500)).toBe(150);
    });

    it('returns ¥123 for ¥1234 (rounds 123.4 → 123)', () => {
      expect(calculateTaxJpy(1234)).toBe(123);
    });

    it('returns ¥124 for ¥1235 (rounds 123.5 → 124)', () => {
      expect(calculateTaxJpy(1235)).toBe(124);
    });

    it('returns ¥500 for ¥5000 (no rounding needed)', () => {
      expect(calculateTaxJpy(5000)).toBe(500);
    });
  });

  describe('calculateInvoiceDueDate', () => {
    it('returns 翌月 25 日 JST 23:59:59 for 通常月', () => {
      // 2026-05 → 2026-06-25 JST 23:59:59 = UTC 14:59:59
      const due = calculateInvoiceDueDate('2026-05');
      expect(due.toISOString()).toBe('2026-06-25T14:59:59.999Z');
    });

    it('handles 年末 (12 月 → 翌年 1 月)', () => {
      const due = calculateInvoiceDueDate('2026-12');
      expect(due.toISOString()).toBe('2027-01-25T14:59:59.999Z');
    });

    it('throws on invalid format', () => {
      expect(() => calculateInvoiceDueDate('invalid')).toThrow();
    });
  });

  describe('isOverdue', () => {
    it('returns false within threshold', () => {
      const dueDate = new Date('2026-06-25T14:59:59.999Z');
      // +3 日 < 閾値 5 日 → 未超過
      const now = new Date('2026-06-28T14:59:59.999Z');
      expect(isOverdue(dueDate, now)).toBe(false);
    });

    it('returns true after threshold (= +5 days)', () => {
      const dueDate = new Date('2026-06-25T14:59:59.999Z');
      // +6 日 > 閾値 5 日 → 超過
      const now = new Date('2026-07-01T15:00:00.000Z');
      expect(isOverdue(dueDate, now)).toBe(true);
    });

    it('uses OVERDUE_ALERT_THRESHOLD_DAYS constant', () => {
      expect(OVERDUE_ALERT_THRESHOLD_DAYS).toBe(5);
    });
  });
});
