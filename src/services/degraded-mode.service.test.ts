/**
 * degraded-mode.service.ts の単体テスト (Q5(3) UI 可視化 / 2026-05-14)
 *
 * 検証項目:
 *   - Beginner: currentMonthApiCallCount >= beginnerMonthlyCallLimit で active=true
 *   - Pro/Expert: currentMonthApiCostJpy >= monthlyBudgetCapJpy で active=true
 *   - Pro/Expert + monthlyBudgetCapJpy=null は無制限なので active=false
 *   - テナント不在は null
 *   - nullEmbeddings は集計結果を含める
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  prisma: {
    tenant: { findFirst: vi.fn() },
    $queryRaw: vi.fn(),
  },
}));

vi.mock('./embedding-backfill.service', () => ({
  countNullEmbeddings: vi.fn(async () => ({
    projects: 0,
    knowledges: 0,
    risksIssues: 0,
    retrospectives: 0,
    total: 0,
  })),
}));

import { getDegradedModeState } from './degraded-mode.service';
import { prisma } from '@/lib/db';
import { countNullEmbeddings } from './embedding-backfill.service';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getDegradedModeState', () => {
  it('Beginner で上限到達なら active=beginner_limit_exceeded', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue({
      plan: 'beginner',
      currentMonthApiCallCount: 100,
      currentMonthApiCostJpy: 0,
      beginnerMonthlyCallLimit: 100,
      monthlyBudgetCapJpy: null,
    } as never);

    const r = await getDegradedModeState('t');
    expect(r?.active).toBe(true);
    expect(r?.reason).toBe('beginner_limit_exceeded');
  });

  it('Beginner で上限未到達なら active=false', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue({
      plan: 'beginner',
      currentMonthApiCallCount: 50,
      currentMonthApiCostJpy: 0,
      beginnerMonthlyCallLimit: 100,
      monthlyBudgetCapJpy: null,
    } as never);

    const r = await getDegradedModeState('t');
    expect(r?.active).toBe(false);
    expect(r?.reason).toBeNull();
  });

  it('Pro で予算到達なら active=budget_exceeded', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue({
      plan: 'pro',
      currentMonthApiCallCount: 100,
      currentMonthApiCostJpy: 5000,
      beginnerMonthlyCallLimit: 100,
      monthlyBudgetCapJpy: 5000,
    } as never);

    const r = await getDegradedModeState('t');
    expect(r?.active).toBe(true);
    expect(r?.reason).toBe('budget_exceeded');
  });

  it('Pro + monthlyBudgetCapJpy=null は無制限で active=false', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue({
      plan: 'pro',
      currentMonthApiCallCount: 9999,
      currentMonthApiCostJpy: 999_999,
      beginnerMonthlyCallLimit: 100,
      monthlyBudgetCapJpy: null,
    } as never);

    const r = await getDegradedModeState('t');
    expect(r?.active).toBe(false);
    expect(r?.reason).toBeNull();
  });

  it('テナント不在は null', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue(null);
    const r = await getDegradedModeState('not-exist');
    expect(r).toBeNull();
  });

  it('nullEmbeddings は集計結果を含める', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue({
      plan: 'beginner',
      currentMonthApiCallCount: 0,
      currentMonthApiCostJpy: 0,
      beginnerMonthlyCallLimit: 100,
      monthlyBudgetCapJpy: null,
    } as never);
    vi.mocked(countNullEmbeddings).mockResolvedValueOnce({
      projects: 3,
      knowledges: 7,
      risksIssues: 2,
      retrospectives: 0,
      total: 12,
    });

    const r = await getDegradedModeState('t');
    expect(r?.nullEmbeddings.total).toBe(12);
    expect(r?.nullEmbeddings.projects).toBe(3);
  });
});
