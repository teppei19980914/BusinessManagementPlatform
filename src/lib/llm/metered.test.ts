import { describe, it, expect, vi, beforeEach } from 'vitest';

// 依存モジュールのモック (import 解決前に hoist される)
vi.mock('@/lib/db', () => ({
  prisma: {
    tenant: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    apiCallLog: {
      create: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

import { withMeteredLLM } from './metered';
import { prisma } from '@/lib/db';
import type { RateLimiter } from './rate-limiter';
import { LLM_MODELS } from '@/config/llm';
import { DEFAULT_TENANT_ID } from '@/lib/tenant';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const USER_ID = 'user-1';

/** Tenant 取得時に返す既定の row。各テストで上書きする。 */
function makeTenant(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: TENANT_ID,
    slug: 'tenant-a',
    name: 'Tenant A',
    plan: 'beginner',
    currentMonthApiCallCount: 0,
    currentMonthApiCostJpy: 0,
    monthlyBudgetCapJpy: null as number | null,
    beginnerMonthlyCallLimit: 100,
    beginnerMaxSeats: 5,
    pricePerCallHaiku: 10,
    pricePerCallSonnet: 30,
    scheduledPlanChangeAt: null,
    scheduledNextPlan: null,
    lastResetAt: null,
    deletedAt: null,
    ...overrides,
  };
}

/** 常に許可する rate limiter スタブ。 */
function allowAllRateLimiter(): RateLimiter {
  return {
    check: vi.fn().mockResolvedValue({ allowed: true }),
  };
}

/** 常に拒否する rate limiter スタブ。 */
function denyAllRateLimiter(retryAfterSec = 30): RateLimiter {
  return {
    check: vi.fn().mockResolvedValue({ allowed: false, retryAfterSec }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // $transaction はデフォルトで「中の operation を順次 await して結果配列を返す」モックにする
  vi.mocked(prisma.$transaction).mockImplementation(async (ops: unknown) =>
    Promise.all((ops as Promise<unknown>[]) ?? []),
  );
});

describe('withMeteredLLM - Step 1: 短期 rate limit', () => {
  it('per-minute 拒否時は LLM を呼ばず rate_limited を返す', async () => {
    const rateLimiter = denyAllRateLimiter(45);
    const call = vi.fn();

    const result = await withMeteredLLM(
      { featureUnit: 'test', tenantId: TENANT_ID, userId: USER_ID, rateLimiter },
      call,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('rate_limited');
      expect(result.retryAfterSec).toBe(45);
    }
    expect(call).not.toHaveBeenCalled();
    expect(prisma.tenant.findFirst).not.toHaveBeenCalled();
  });

  it('userId 未指定時は rate limit をスキップする (cron / システム実行)', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue(makeTenant() as never);
    const rateLimiter = denyAllRateLimiter();
    const call = vi.fn().mockResolvedValue({ result: 'ok' });

    const result = await withMeteredLLM(
      { featureUnit: 'cron-job', tenantId: TENANT_ID, rateLimiter },
      call,
    );

    expect(rateLimiter.check).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
  });

  it('per-minute 通過 + per-hour 拒否でも rate_limited を返す', async () => {
    const rateLimiter: RateLimiter = {
      check: vi
        .fn()
        .mockResolvedValueOnce({ allowed: true })
        .mockResolvedValueOnce({ allowed: false, retryAfterSec: 1800 }),
    };
    const call = vi.fn();

    const result = await withMeteredLLM(
      { featureUnit: 'test', tenantId: TENANT_ID, userId: USER_ID, rateLimiter },
      call,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('rate_limited');
    expect(call).not.toHaveBeenCalled();
  });
});

describe('withMeteredLLM - Step 2: Tenant 取得 + plan 解決', () => {
  it('Tenant 不在時は tenant_inactive を返す', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue(null);
    const call = vi.fn();

    const result = await withMeteredLLM(
      {
        featureUnit: 'test',
        tenantId: TENANT_ID,
        userId: USER_ID,
        rateLimiter: allowAllRateLimiter(),
      },
      call,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('tenant_inactive');
    expect(call).not.toHaveBeenCalled();
  });

  it('plan 値が不正なら plan_invalid を返す', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue(
      makeTenant({ plan: 'free' }) as never, // 'free' は許可されない値
    );
    const call = vi.fn();

    const result = await withMeteredLLM(
      {
        featureUnit: 'test',
        tenantId: TENANT_ID,
        userId: USER_ID,
        rateLimiter: allowAllRateLimiter(),
      },
      call,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('plan_invalid');
    expect(call).not.toHaveBeenCalled();
  });
});

describe('withMeteredLLM - Step 3: Beginner プラン月間上限', () => {
  it('Beginner で currentMonthApiCallCount >= limit なら beginner_limit_exceeded', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue(
      makeTenant({
        plan: 'beginner',
        beginnerMonthlyCallLimit: 100,
        currentMonthApiCallCount: 100,
      }) as never,
    );
    const call = vi.fn();

    const result = await withMeteredLLM(
      {
        featureUnit: 'test',
        tenantId: TENANT_ID,
        userId: USER_ID,
        rateLimiter: allowAllRateLimiter(),
      },
      call,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('beginner_limit_exceeded');
    expect(call).not.toHaveBeenCalled();
  });

  it('Beginner で limit 直前 (99/100) なら通過する', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue(
      makeTenant({
        plan: 'beginner',
        beginnerMonthlyCallLimit: 100,
        currentMonthApiCallCount: 99,
      }) as never,
    );
    const call = vi.fn().mockResolvedValue({ result: 'ok' });

    const result = await withMeteredLLM(
      {
        featureUnit: 'test',
        tenantId: TENANT_ID,
        userId: USER_ID,
        rateLimiter: allowAllRateLimiter(),
      },
      call,
    );

    expect(result.ok).toBe(true);
  });

  it('Expert / Pro プランは beginner 上限を無視する (無制限従量課金)', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue(
      makeTenant({
        plan: 'expert',
        beginnerMonthlyCallLimit: 100,
        currentMonthApiCallCount: 999, // beginner なら超過、expert は無視
      }) as never,
    );
    const call = vi.fn().mockResolvedValue({ result: 'ok' });

    const result = await withMeteredLLM(
      {
        featureUnit: 'test',
        tenantId: TENANT_ID,
        userId: USER_ID,
        rateLimiter: allowAllRateLimiter(),
      },
      call,
    );

    expect(result.ok).toBe(true);
  });
});

describe('withMeteredLLM - Step 4: monthlyBudgetCapJpy 予測超過', () => {
  it('予測コスト追加で予算超過すれば budget_exceeded', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue(
      makeTenant({
        plan: 'expert',
        currentMonthApiCostJpy: 950,
        pricePerCallHaiku: 10,
        monthlyBudgetCapJpy: 955, // 950 + 10 > 955 で拒否
      }) as never,
    );
    const call = vi.fn();

    const result = await withMeteredLLM(
      {
        featureUnit: 'test',
        tenantId: TENANT_ID,
        userId: USER_ID,
        rateLimiter: allowAllRateLimiter(),
      },
      call,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('budget_exceeded');
    expect(call).not.toHaveBeenCalled();
  });

  it('予算ちょうど境界 (==) は通過する', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue(
      makeTenant({
        plan: 'expert',
        currentMonthApiCostJpy: 990,
        pricePerCallHaiku: 10,
        monthlyBudgetCapJpy: 1000, // 990 + 10 = 1000 (>=ではなく > なので通る)
      }) as never,
    );
    const call = vi.fn().mockResolvedValue({ result: 'ok' });

    const result = await withMeteredLLM(
      {
        featureUnit: 'test',
        tenantId: TENANT_ID,
        userId: USER_ID,
        rateLimiter: allowAllRateLimiter(),
      },
      call,
    );

    expect(result.ok).toBe(true);
  });

  it('monthlyBudgetCapJpy が null なら無制限扱いで通過', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue(
      makeTenant({
        plan: 'expert',
        currentMonthApiCostJpy: 999_999,
        monthlyBudgetCapJpy: null,
      }) as never,
    );
    const call = vi.fn().mockResolvedValue({ result: 'ok' });

    const result = await withMeteredLLM(
      {
        featureUnit: 'test',
        tenantId: TENANT_ID,
        userId: USER_ID,
        rateLimiter: allowAllRateLimiter(),
      },
      call,
    );

    expect(result.ok).toBe(true);
  });

  it('predictedCostJpy 上書きで Embedding 等の特殊コストを表現できる', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue(
      makeTenant({
        plan: 'expert',
        currentMonthApiCostJpy: 95,
        pricePerCallHaiku: 10, // plan 単価は 10
        monthlyBudgetCapJpy: 100,
      }) as never,
    );
    const call = vi.fn();

    // predictedCostJpy=20 を渡して 95+20>100 で拒否されることを確認
    const result = await withMeteredLLM(
      {
        featureUnit: 'embedding-batch',
        tenantId: TENANT_ID,
        userId: USER_ID,
        predictedCostJpy: 20,
        rateLimiter: allowAllRateLimiter(),
      },
      call,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('budget_exceeded');
  });
});

describe('withMeteredLLM - Step 5: LLM 呼び出し失敗', () => {
  it('callback が throw したら llm_error を返す (カウンタは進めない)', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue(makeTenant() as never);
    const err = new Error('anthropic 5xx');
    const call = vi.fn().mockRejectedValue(err);

    const result = await withMeteredLLM(
      {
        featureUnit: 'test',
        tenantId: TENANT_ID,
        userId: USER_ID,
        rateLimiter: allowAllRateLimiter(),
      },
      call,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('llm_error');
      if (result.reason === 'llm_error') {
        expect(result.error).toBe(err);
      }
    }
    // カウンタ更新も ApiCallLog 作成もされない (ユーザに課金しない)
    expect(prisma.tenant.update).not.toHaveBeenCalled();
    expect(prisma.apiCallLog.create).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('withMeteredLLM - Step 6: 成功時の increment + ApiCallLog 記録', () => {
  it('Beginner プラン: model=Haiku, cost=0, ApiCallLog に記録', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue(
      makeTenant({ plan: 'beginner' }) as never,
    );
    const call = vi.fn().mockResolvedValue({
      result: 'tagged',
      usage: { llmInputTokens: 100, llmOutputTokens: 50 },
    });

    const result = await withMeteredLLM(
      {
        featureUnit: 'auto-tag-extract',
        tenantId: TENANT_ID,
        userId: USER_ID,
        rateLimiter: allowAllRateLimiter(),
      },
      call,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.modelName).toBe(LLM_MODELS.HAIKU);
      expect(result.costJpy).toBe(0);
      expect(result.result).toBe('tagged');
    }

    // call() に modelName と requestId が渡される
    expect(call).toHaveBeenCalledTimes(1);
    const ctx = vi.mocked(call).mock.calls[0]![0];
    expect(ctx.modelName).toBe(LLM_MODELS.HAIKU);
    expect(ctx.requestId).toMatch(/^[0-9a-f-]{36}$/);

    // tenant 更新が呼ばれた
    const tenantUpdateCall = vi.mocked(prisma.tenant.update).mock.calls[0]![0];
    expect(tenantUpdateCall).toMatchObject({
      where: { id: TENANT_ID },
      data: {
        currentMonthApiCallCount: { increment: 1 },
        currentMonthApiCostJpy: { increment: 0 }, // beginner = 無料
      },
    });

    // ApiCallLog 作成
    const logCall = vi.mocked(prisma.apiCallLog.create).mock.calls[0]![0];
    expect(logCall.data).toMatchObject({
      tenantId: TENANT_ID,
      userId: USER_ID,
      featureUnit: 'auto-tag-extract',
      modelName: LLM_MODELS.HAIKU,
      llmInputTokens: 100,
      llmOutputTokens: 50,
      costJpy: 0,
    });
    expect(logCall.data.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('Expert プラン: model=Haiku, cost=pricePerCallHaiku', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue(
      makeTenant({ plan: 'expert', pricePerCallHaiku: 10 }) as never,
    );
    const call = vi.fn().mockResolvedValue({ result: 'x' });

    const result = await withMeteredLLM(
      {
        featureUnit: 'test',
        tenantId: TENANT_ID,
        userId: USER_ID,
        rateLimiter: allowAllRateLimiter(),
      },
      call,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.modelName).toBe(LLM_MODELS.HAIKU);
      expect(result.costJpy).toBe(10);
    }
  });

  it('Pro プラン: model=Sonnet, cost=pricePerCallSonnet', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue(
      makeTenant({ plan: 'pro', pricePerCallSonnet: 30 }) as never,
    );
    const call = vi.fn().mockResolvedValue({ result: 'x' });

    const result = await withMeteredLLM(
      {
        featureUnit: 'test',
        tenantId: TENANT_ID,
        userId: USER_ID,
        rateLimiter: allowAllRateLimiter(),
      },
      call,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.modelName).toBe(LLM_MODELS.SONNET);
      expect(result.costJpy).toBe(30);
    }
  });

  it('increment と ApiCallLog 作成は単一 transaction で実行される (整合性担保)', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue(makeTenant() as never);
    const call = vi.fn().mockResolvedValue({ result: 'x' });

    await withMeteredLLM(
      {
        featureUnit: 'test',
        tenantId: TENANT_ID,
        userId: USER_ID,
        rateLimiter: allowAllRateLimiter(),
      },
      call,
    );

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('userId 省略時 (cron) は ApiCallLog.userId=null', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue(
      makeTenant({ plan: 'expert' }) as never,
    );
    const call = vi.fn().mockResolvedValue({ result: 'x' });

    await withMeteredLLM(
      {
        featureUnit: 'cron-task',
        tenantId: TENANT_ID,
        rateLimiter: allowAllRateLimiter(),
      },
      call,
    );

    const logCall = vi.mocked(prisma.apiCallLog.create).mock.calls[0]![0];
    expect(logCall.data.userId).toBeUndefined();
  });

  it('default-tenant の固定 UUID でも問題なく動作する (v1 単一テナント運用)', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue(
      makeTenant({ id: DEFAULT_TENANT_ID }) as never,
    );
    const call = vi.fn().mockResolvedValue({ result: 'ok' });

    const result = await withMeteredLLM(
      {
        featureUnit: 'test',
        tenantId: DEFAULT_TENANT_ID,
        userId: USER_ID,
        rateLimiter: allowAllRateLimiter(),
      },
      call,
    );

    expect(result.ok).toBe(true);
  });
});

describe('withMeteredLLM - requestId 生成と伝播', () => {
  it('requestId 未指定時は UUID v4 形式が自動生成される', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue(makeTenant() as never);
    const call = vi.fn().mockResolvedValue({ result: 'x' });

    const result = await withMeteredLLM(
      {
        featureUnit: 'test',
        tenantId: TENANT_ID,
        userId: USER_ID,
        rateLimiter: allowAllRateLimiter(),
      },
      call,
    );

    if (result.ok) {
      expect(result.requestId).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it('requestId 指定時はその値が ApiCallLog.requestId に入る', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue(makeTenant() as never);
    const call = vi.fn().mockResolvedValue({ result: 'x' });
    const explicit = 'req-explicit-12345';

    await withMeteredLLM(
      {
        featureUnit: 'test',
        tenantId: TENANT_ID,
        userId: USER_ID,
        requestId: explicit,
        rateLimiter: allowAllRateLimiter(),
      },
      call,
    );

    const logCall = vi.mocked(prisma.apiCallLog.create).mock.calls[0]![0];
    expect(logCall.data.requestId).toBe(explicit);
  });
});
