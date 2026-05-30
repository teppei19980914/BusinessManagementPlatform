/**
 * diagnostics.service.ts (listDegradedTenants) のテスト。
 *
 * 役割:
 *   super_admin 診断ダッシュボード経由で「LLM 縮退」「Embedding 縮退」の両軸を検知できることを保証する。
 *   ADR-0030 (2026-05-30) 導入で Embedding 系 2 reason が追加されたため、これらが
 *   `listDegradedTenants` で漏れなく検出されるかが本テストの中心。
 *
 * 関連:
 *   - ADR: docs/adr/0030-embedding-monthly-budget-cap.md
 *   - 実装: src/services/diagnostics.service.ts listDegradedTenants
 *   - UI: src/app/(dashboard)/admin/super/diagnostics/page.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  prisma: {
    tenant: { findMany: vi.fn() },
  },
}));

import { listDegradedTenants } from './diagnostics.service';
import { prisma } from '@/lib/db';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('listDegradedTenants - LLM 系 (既存)', () => {
  it('Beginner で LLM 50 件上限到達なら beginner_limit_exceeded', async () => {
    vi.mocked(prisma.tenant.findMany).mockResolvedValue([
      {
        id: 't1',
        name: 'T1',
        plan: 'beginner',
        currentMonthApiCallCount: 50,
        currentMonthApiCostJpy: 0,
        currentMonthEmbeddingCallCount: 0,
        currentMonthEmbeddingCostJpy: 0,
        beginnerMonthlyCallLimit: 50,
        monthlyBudgetCapJpy: null,
        monthlyEmbeddingBudgetCapJpy: null,
      },
    ] as never);

    const result = await listDegradedTenants();
    expect(result).toHaveLength(1);
    expect(result[0].reason).toBe('beginner_limit_exceeded');
  });

  it('Expert で LLM 予算上限到達なら budget_exceeded', async () => {
    vi.mocked(prisma.tenant.findMany).mockResolvedValue([
      {
        id: 't1',
        name: 'T1',
        plan: 'expert',
        currentMonthApiCallCount: 500,
        currentMonthApiCostJpy: 5000,
        currentMonthEmbeddingCallCount: 0,
        currentMonthEmbeddingCostJpy: 0,
        beginnerMonthlyCallLimit: 50,
        monthlyBudgetCapJpy: 5000,
        monthlyEmbeddingBudgetCapJpy: null,
      },
    ] as never);

    const result = await listDegradedTenants();
    expect(result).toHaveLength(1);
    expect(result[0].reason).toBe('budget_exceeded');
  });
});

describe('listDegradedTenants - Embedding 系 (ADR-0030)', () => {
  it('ADR-0030: Beginner で Embedding 100 件到達なら embedding_beginner_limit_exceeded', async () => {
    vi.mocked(prisma.tenant.findMany).mockResolvedValue([
      {
        id: 't1',
        name: 'T1',
        plan: 'beginner',
        currentMonthApiCallCount: 10, // LLM 未超過
        currentMonthApiCostJpy: 0,
        currentMonthEmbeddingCallCount: 100, // Embedding 到達
        currentMonthEmbeddingCostJpy: 0,
        beginnerMonthlyCallLimit: 50,
        monthlyBudgetCapJpy: null,
        monthlyEmbeddingBudgetCapJpy: null,
      },
    ] as never);

    const result = await listDegradedTenants();
    expect(result).toHaveLength(1);
    expect(result[0].reason).toBe('embedding_beginner_limit_exceeded');
    expect(result[0].beginnerEmbeddingMonthlyLimit).toBe(100);
  });

  it('ADR-0030: Pro で Embedding 予算上限到達なら embedding_budget_exceeded', async () => {
    vi.mocked(prisma.tenant.findMany).mockResolvedValue([
      {
        id: 't1',
        name: 'T1',
        plan: 'pro',
        currentMonthApiCallCount: 0,
        currentMonthApiCostJpy: 0,
        currentMonthEmbeddingCallCount: 600,
        currentMonthEmbeddingCostJpy: 3000, // 到達 (600 × ¥5)
        beginnerMonthlyCallLimit: 50,
        monthlyBudgetCapJpy: null,
        monthlyEmbeddingBudgetCapJpy: 3000,
      },
    ] as never);

    const result = await listDegradedTenants();
    expect(result).toHaveLength(1);
    expect(result[0].reason).toBe('embedding_budget_exceeded');
    expect(result[0].monthlyEmbeddingBudgetCapJpy).toBe(3000);
  });

  it('ADR-0030: LLM 経路が先に発火している場合は LLM 側 reason のみ返却 (重複しない)', async () => {
    vi.mocked(prisma.tenant.findMany).mockResolvedValue([
      {
        id: 't1',
        name: 'T1',
        plan: 'beginner',
        currentMonthApiCallCount: 50, // LLM 到達
        currentMonthApiCostJpy: 0,
        currentMonthEmbeddingCallCount: 100, // Embedding も到達
        currentMonthEmbeddingCostJpy: 0,
        beginnerMonthlyCallLimit: 50,
        monthlyBudgetCapJpy: null,
        monthlyEmbeddingBudgetCapJpy: null,
      },
    ] as never);

    const result = await listDegradedTenants();
    // 1 テナント = 1 reason (= metered.ts の優先順位と整合)
    expect(result).toHaveLength(1);
    expect(result[0].reason).toBe('beginner_limit_exceeded');
  });

  it('ADR-0030: 縮退なしテナントは空配列', async () => {
    vi.mocked(prisma.tenant.findMany).mockResolvedValue([
      {
        id: 't1',
        name: 'T1',
        plan: 'expert',
        currentMonthApiCallCount: 5,
        currentMonthApiCostJpy: 50,
        currentMonthEmbeddingCallCount: 5,
        currentMonthEmbeddingCostJpy: 25,
        beginnerMonthlyCallLimit: 50,
        monthlyBudgetCapJpy: 1000,
        monthlyEmbeddingBudgetCapJpy: 1000,
      },
    ] as never);

    const result = await listDegradedTenants();
    expect(result).toHaveLength(0);
  });
});
