/**
 * usage-monitoring.service.ts の単体テスト (PR #7 / T-03)
 *
 * 検証項目:
 *   - 日次集計の SQL 結果整形
 *   - 異常検知の倍率閾値
 *   - 異常検知の対象外条件 (ローリング平均 < MIN_ROLLING_AVG_FOR_DETECTION)
 *   - 予算アラートの level 判定 (80% / 100% / 150%)
 *
 * **2026-05-14**: メール通知の廃止に伴い `notifyAdminsOfAlerts` 関連テストを削除。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  prisma: {
    $queryRaw: vi.fn(),
    tenant: {
      findMany: vi.fn(),
    },
  },
}));

import {
  getDailyUsageByTenant,
  detectAnomalies,
  detectBudgetAlerts,
} from './usage-monitoring.service';
import { prisma } from '@/lib/db';

// ----------------------------------------------------------------
// getDailyUsageByTenant
// ----------------------------------------------------------------
describe('getDailyUsageByTenant', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('raw SQL 行を DailyUsageRow にマッピングする (BigInt → Number 変換)', async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValueOnce([
      {
        tenant_id: 'tenant-a',
        tenant_name: 'Tenant A',
        call_count: 42n,
        cost_jpy: 420n,
        embedding_tokens: 12000n,
        llm_input_tokens: 5000n,
        llm_output_tokens: 500n,
      },
    ] as never);

    const result = await getDailyUsageByTenant(new Date('2026-05-03T12:00:00Z'));
    expect(result).toEqual([
      {
        tenantId: 'tenant-a',
        tenantName: 'Tenant A',
        callCount: 42,
        costJpy: 420,
        embeddingTokens: 12000,
        llmInputTokens: 5000,
        llmOutputTokens: 500,
      },
    ]);
  });

  it('NULL token カラムは 0 として扱う', async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValueOnce([
      {
        tenant_id: 't',
        tenant_name: 'T',
        call_count: 1n,
        cost_jpy: 10n,
        embedding_tokens: null,
        llm_input_tokens: null,
        llm_output_tokens: null,
      },
    ] as never);

    const result = await getDailyUsageByTenant(new Date());
    expect(result[0]?.embeddingTokens).toBe(0);
    expect(result[0]?.llmInputTokens).toBe(0);
    expect(result[0]?.llmOutputTokens).toBe(0);
  });
});

// ----------------------------------------------------------------
// detectAnomalies
// ----------------------------------------------------------------
describe('detectAnomalies', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('過去 7 日平均の 5 倍以上で異常検知 (5x ぴったりは閾値到達と判定)', async () => {
    // 1 回目: getDailyUsageByTenant → 当日 50 件
    vi.mocked(prisma.$queryRaw)
      .mockResolvedValueOnce([
        {
          tenant_id: 'tenant-a',
          tenant_name: 'Tenant A',
          call_count: 50n,
          cost_jpy: 500n,
          embedding_tokens: 0n,
          llm_input_tokens: 0n,
          llm_output_tokens: 0n,
        },
      ] as never)
      // 2 回目: getRollingAvgCallsByTenant → 7 日平均 10
      .mockResolvedValueOnce([
        { tenant_id: 'tenant-a', avg_calls: 10 },
      ] as never);

    const anomalies = await detectAnomalies(new Date('2026-05-03T12:00:00Z'));
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0].multiplier).toBe(5);
    expect(anomalies[0].todayCalls).toBe(50);
  });

  it('5 倍未満は検知しない', async () => {
    vi.mocked(prisma.$queryRaw)
      .mockResolvedValueOnce([
        {
          tenant_id: 'tenant-a',
          tenant_name: 'Tenant A',
          call_count: 30n, // 3x のみ
          cost_jpy: 300n,
          embedding_tokens: 0n,
          llm_input_tokens: 0n,
          llm_output_tokens: 0n,
        },
      ] as never)
      .mockResolvedValueOnce([
        { tenant_id: 'tenant-a', avg_calls: 10 },
      ] as never);

    const anomalies = await detectAnomalies(new Date());
    expect(anomalies).toHaveLength(0);
  });

  it('ローリング平均が小さすぎる (< 5) テナントは検知対象外 (新規テナント保護)', async () => {
    vi.mocked(prisma.$queryRaw)
      .mockResolvedValueOnce([
        {
          tenant_id: 'new-tenant',
          tenant_name: 'New',
          call_count: 100n, // 一見大量だが新規ゆえに検知しない
          cost_jpy: 1000n,
          embedding_tokens: 0n,
          llm_input_tokens: 0n,
          llm_output_tokens: 0n,
        },
      ] as never)
      .mockResolvedValueOnce([
        { tenant_id: 'new-tenant', avg_calls: 2 }, // 7 日平均が < 5
      ] as never);

    const anomalies = await detectAnomalies(new Date());
    expect(anomalies).toHaveLength(0);
  });

  it('ローリング平均に存在しないテナント (=過去 0 件) は検知対象外', async () => {
    vi.mocked(prisma.$queryRaw)
      .mockResolvedValueOnce([
        {
          tenant_id: 'today-only',
          tenant_name: 'Today Only',
          call_count: 100n,
          cost_jpy: 1000n,
          embedding_tokens: 0n,
          llm_input_tokens: 0n,
          llm_output_tokens: 0n,
        },
      ] as never)
      .mockResolvedValueOnce([] as never); // ローリング窓内にデータなし

    const anomalies = await detectAnomalies(new Date());
    expect(anomalies).toHaveLength(0);
  });
});

// ----------------------------------------------------------------
// detectBudgetAlerts
// ----------------------------------------------------------------
describe('detectBudgetAlerts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('80% / 100% / 150% の閾値で level を判定する', async () => {
    vi.mocked(prisma.tenant.findMany).mockResolvedValue([
      { id: 't1', name: 'T1', currentMonthApiCostJpy: 800, monthlyBudgetCapJpy: 1000 },  // 80% → warning
      { id: 't2', name: 'T2', currentMonthApiCostJpy: 1000, monthlyBudgetCapJpy: 1000 }, // 100% → critical
      { id: 't3', name: 'T3', currentMonthApiCostJpy: 1500, monthlyBudgetCapJpy: 1000 }, // 150% → overage
      { id: 't4', name: 'T4', currentMonthApiCostJpy: 100, monthlyBudgetCapJpy: 1000 },  // 10% → 通知対象外
    ] as never);

    const alerts = await detectBudgetAlerts();
    expect(alerts).toHaveLength(3);
    expect(alerts.find((a) => a.tenantId === 't1')?.level).toBe('warning_80');
    expect(alerts.find((a) => a.tenantId === 't2')?.level).toBe('critical_100');
    expect(alerts.find((a) => a.tenantId === 't3')?.level).toBe('overage_150');
  });

  it('budget_cap が 0 のテナントは ZeroDivision を避けてスキップ', async () => {
    vi.mocked(prisma.tenant.findMany).mockResolvedValue([
      { id: 't1', name: 'T1', currentMonthApiCostJpy: 100, monthlyBudgetCapJpy: 0 },
    ] as never);

    const alerts = await detectBudgetAlerts();
    expect(alerts).toHaveLength(0);
  });
});

// notifyAdminsOfAlerts は 2026-05-14 に廃止されたためテスト削除。
