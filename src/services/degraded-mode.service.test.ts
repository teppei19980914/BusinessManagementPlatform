/**
 * degraded-mode.service.ts の単体テスト (Q5(3) UI 可視化 / 2026-05-14)
 *
 * 検証項目:
 *   - getDegradedModeState (詳細版 / settings 画面用):
 *     - Beginner: currentMonthApiCallCount >= beginnerMonthlyCallLimit で active=true
 *     - Pro/Expert: currentMonthApiCostJpy >= monthlyBudgetCapJpy で active=true
 *     - Pro/Expert + monthlyBudgetCapJpy=null は無制限なので active=false
 *     - テナント不在は null
 *     - nullEmbeddings は集計結果を含める
 *   - getDegradedModeBannerState (軽量版 / dashboard layout 用 / perf/dashboard-layout-parallel-ssr):
 *     - 4 reason すべてで正しく active / reason を返す
 *     - countNullEmbeddings を呼ばない (= dashboard layout で毎リクエスト走っても軽い)
 *     - 戻り値に nullEmbeddings プロパティが含まれない
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
    memos: 0, // (2026-05-15) Memo 追加
    total: 0,
  })),
}));

import {
  getDegradedModeState,
  getDegradedModeBannerState,
} from './degraded-mode.service';
import { prisma } from '@/lib/db';
import { countNullEmbeddings } from './embedding-backfill.service';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getDegradedModeState', () => {
  it('Beginner で上限到達なら active=beginner_limit_exceeded', async () => {
    // ADR-0019 (2026-05-24): Beginner 上限 100 → 50 (課金対象 call のみカウント)
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue({
      plan: 'beginner',
      currentMonthApiCallCount: 50,
      currentMonthApiCostJpy: 0,
      beginnerMonthlyCallLimit: 50,
      monthlyBudgetCapJpy: null,
    } as never);

    const r = await getDegradedModeState('t');
    expect(r?.active).toBe(true);
    expect(r?.reason).toBe('beginner_limit_exceeded');
  });

  it('Beginner で上限未到達なら active=false', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue({
      plan: 'beginner',
      currentMonthApiCallCount: 25,
      currentMonthApiCostJpy: 0,
      beginnerMonthlyCallLimit: 50,
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
      beginnerMonthlyCallLimit: 50, // ADR-0019 default (Pro なので無視されるが整合性のため)
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
      beginnerMonthlyCallLimit: 50,
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

  // ADR-0030 (2026-05-30): Embedding 系 2 reason の判定テスト
  it('ADR-0030: Beginner Embedding 100 件到達なら active=embedding_beginner_limit_exceeded', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue({
      plan: 'beginner',
      currentMonthApiCallCount: 0,
      currentMonthApiCostJpy: 0,
      currentMonthEmbeddingCallCount: 100, // 到達
      currentMonthEmbeddingCostJpy: 0,
      beginnerMonthlyCallLimit: 50,
      monthlyBudgetCapJpy: null,
      monthlyEmbeddingBudgetCapJpy: null,
    } as never);

    const r = await getDegradedModeState('t');
    expect(r?.active).toBe(true);
    expect(r?.reason).toBe('embedding_beginner_limit_exceeded');
  });

  it('ADR-0030: Pro Embedding 予算到達なら active=embedding_budget_exceeded', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue({
      plan: 'pro',
      currentMonthApiCallCount: 0,
      currentMonthApiCostJpy: 0,
      currentMonthEmbeddingCallCount: 600,
      currentMonthEmbeddingCostJpy: 3000, // 上限到達 (600 × ¥5)
      beginnerMonthlyCallLimit: 50,
      monthlyBudgetCapJpy: null,
      monthlyEmbeddingBudgetCapJpy: 3000,
    } as never);

    const r = await getDegradedModeState('t');
    expect(r?.active).toBe(true);
    expect(r?.reason).toBe('embedding_budget_exceeded');
  });

  it('ADR-0030: LLM 経路が先に発火している場合は LLM 側 reason を優先', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue({
      plan: 'pro',
      currentMonthApiCallCount: 100,
      currentMonthApiCostJpy: 5000, // LLM 予算到達
      currentMonthEmbeddingCallCount: 600,
      currentMonthEmbeddingCostJpy: 3000, // Embedding 予算も到達 (両方発火条件)
      beginnerMonthlyCallLimit: 50,
      monthlyBudgetCapJpy: 5000,
      monthlyEmbeddingBudgetCapJpy: 3000,
    } as never);

    const r = await getDegradedModeState('t');
    expect(r?.active).toBe(true);
    // LLM 経路が先に判定されるため budget_exceeded が優先
    expect(r?.reason).toBe('budget_exceeded');
  });

  it('nullEmbeddings は集計結果を含める', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue({
      plan: 'beginner',
      currentMonthApiCallCount: 0,
      currentMonthApiCostJpy: 0,
      beginnerMonthlyCallLimit: 50,
      monthlyBudgetCapJpy: null,
    } as never);
    vi.mocked(countNullEmbeddings).mockResolvedValueOnce({
      projects: 3,
      knowledges: 7,
      risksIssues: 2,
      retrospectives: 0,
      memos: 0, // (2026-05-15) Memo 追加
      total: 12,
    });

    const r = await getDegradedModeState('t');
    expect(r?.nullEmbeddings.total).toBe(12);
    expect(r?.nullEmbeddings.projects).toBe(3);
  });
});

/**
 * getDegradedModeBannerState (perf/dashboard-layout-parallel-ssr / 2026-06-01):
 *   dashboard layout 経路用の軽量版。countNullEmbeddings を含まない。
 *   既存 4 reason の判定ロジックは getDegradedModeState と共通だが、本テストでは
 *   軽量経路で同じ結果になることと、countNullEmbeddings を呼ばないことを担保する。
 */
describe('getDegradedModeBannerState', () => {
  it('Beginner LLM 上限到達で active=beginner_limit_exceeded', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue({
      plan: 'beginner',
      currentMonthApiCallCount: 50,
      currentMonthApiCostJpy: 0,
      currentMonthEmbeddingCallCount: 0,
      currentMonthEmbeddingCostJpy: 0,
      beginnerMonthlyCallLimit: 50,
      monthlyBudgetCapJpy: null,
      monthlyEmbeddingBudgetCapJpy: null,
    } as never);

    const r = await getDegradedModeBannerState('t');
    expect(r?.active).toBe(true);
    expect(r?.reason).toBe('beginner_limit_exceeded');
  });

  it('Pro LLM 予算到達で active=budget_exceeded', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue({
      plan: 'pro',
      currentMonthApiCallCount: 100,
      currentMonthApiCostJpy: 5000,
      currentMonthEmbeddingCallCount: 0,
      currentMonthEmbeddingCostJpy: 0,
      beginnerMonthlyCallLimit: 50,
      monthlyBudgetCapJpy: 5000,
      monthlyEmbeddingBudgetCapJpy: null,
    } as never);

    const r = await getDegradedModeBannerState('t');
    expect(r?.active).toBe(true);
    expect(r?.reason).toBe('budget_exceeded');
  });

  it('ADR-0030: Beginner Embedding 100 件到達で active=embedding_beginner_limit_exceeded', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue({
      plan: 'beginner',
      currentMonthApiCallCount: 0,
      currentMonthApiCostJpy: 0,
      currentMonthEmbeddingCallCount: 100,
      currentMonthEmbeddingCostJpy: 0,
      beginnerMonthlyCallLimit: 50,
      monthlyBudgetCapJpy: null,
      monthlyEmbeddingBudgetCapJpy: null,
    } as never);

    const r = await getDegradedModeBannerState('t');
    expect(r?.active).toBe(true);
    expect(r?.reason).toBe('embedding_beginner_limit_exceeded');
  });

  it('ADR-0030: Pro Embedding 予算到達で active=embedding_budget_exceeded', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue({
      plan: 'pro',
      currentMonthApiCallCount: 0,
      currentMonthApiCostJpy: 0,
      currentMonthEmbeddingCallCount: 600,
      currentMonthEmbeddingCostJpy: 3000,
      beginnerMonthlyCallLimit: 50,
      monthlyBudgetCapJpy: null,
      monthlyEmbeddingBudgetCapJpy: 3000,
    } as never);

    const r = await getDegradedModeBannerState('t');
    expect(r?.active).toBe(true);
    expect(r?.reason).toBe('embedding_budget_exceeded');
  });

  it('全条件未到達で active=false / reason=null', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue({
      plan: 'beginner',
      currentMonthApiCallCount: 10,
      currentMonthApiCostJpy: 0,
      currentMonthEmbeddingCallCount: 5,
      currentMonthEmbeddingCostJpy: 0,
      beginnerMonthlyCallLimit: 50,
      monthlyBudgetCapJpy: null,
      monthlyEmbeddingBudgetCapJpy: null,
    } as never);

    const r = await getDegradedModeBannerState('t');
    expect(r?.active).toBe(false);
    expect(r?.reason).toBeNull();
  });

  it('テナント不在で null を返す', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue(null);
    const r = await getDegradedModeBannerState('not-exist');
    expect(r).toBeNull();
  });

  it('countNullEmbeddings を呼ばない (= layout で軽量に毎リクエスト呼べる保証)', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue({
      plan: 'beginner',
      currentMonthApiCallCount: 0,
      currentMonthApiCostJpy: 0,
      currentMonthEmbeddingCallCount: 0,
      currentMonthEmbeddingCostJpy: 0,
      beginnerMonthlyCallLimit: 50,
      monthlyBudgetCapJpy: null,
      monthlyEmbeddingBudgetCapJpy: null,
    } as never);

    await getDegradedModeBannerState('t');
    expect(vi.mocked(countNullEmbeddings)).not.toHaveBeenCalled();
  });

  it('戻り値に nullEmbeddings プロパティが含まれない (型レベルでも実体でも)', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue({
      plan: 'beginner',
      currentMonthApiCallCount: 0,
      currentMonthApiCostJpy: 0,
      currentMonthEmbeddingCallCount: 0,
      currentMonthEmbeddingCostJpy: 0,
      beginnerMonthlyCallLimit: 50,
      monthlyBudgetCapJpy: null,
      monthlyEmbeddingBudgetCapJpy: null,
    } as never);

    const r = await getDegradedModeBannerState('t');
    expect(r).not.toBeNull();
    // ランタイムでも nullEmbeddings キーが付かないことを担保 (詳細版との差別化)
    expect(r && 'nullEmbeddings' in r).toBe(false);
  });
});
