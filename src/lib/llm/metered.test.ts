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
      // ADR-0019 (2026-05-24): fair-use-limit が無料 featureUnit 呼出時に count を実行する。
      // デフォルトは 0 件 (= fair use limit に余裕あり) を返す。各テストで上書き可能。
      count: vi.fn().mockResolvedValue(0),
    },
    // PR-S6 (2026-05-14): credit_card テナントの Stripe Usage Record queue
    stripeUsageRecordQueue: {
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
    // ADR-0019 (2026-05-24): Beginner 上限 100 → 50 (課金対象 call のみカウント)
    beginnerMonthlyCallLimit: 50,
    beginnerMaxSeats: 5,
    pricePerCallHaiku: 10,
    pricePerCallSonnet: 15,
    scheduledPlanChangeAt: null,
    scheduledNextPlan: null,
    lastResetAt: null,
    deletedAt: null,
    // PR-S6 (2026-05-14): Stripe 関連フィールド (default: credit_card ではない invoice テナント)
    // PR-V8 (2026-05-19): Meter API 移行で stripeCustomerId が判定キーに変更
    paymentMethod: 'invoice',
    stripeCustomerId: null as string | null,
    stripeSubscriptionItemHaikuId: null as string | null,
    stripeSubscriptionItemSonnetId: null as string | null,
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
        featureUnit: 'project-upsert',
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
        featureUnit: 'project-upsert',
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
  // ADR-0019 (2026-05-24): Beginner 上限 100 → 50 (課金対象 call のみカウント)
  it('Beginner で currentMonthApiCallCount >= limit なら beginner_limit_exceeded', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue(
      makeTenant({
        plan: 'beginner',
        beginnerMonthlyCallLimit: 50,
        currentMonthApiCallCount: 50,
      }) as never,
    );
    const call = vi.fn();

    const result = await withMeteredLLM(
      {
        featureUnit: 'project-upsert',
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

  it('Beginner で limit 直前 (49/50) なら通過する', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue(
      makeTenant({
        plan: 'beginner',
        beginnerMonthlyCallLimit: 50,
        currentMonthApiCallCount: 49,
      }) as never,
    );
    const call = vi.fn().mockResolvedValue({ result: 'ok' });

    const result = await withMeteredLLM(
      {
        featureUnit: 'project-upsert',
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
        beginnerMonthlyCallLimit: 50,
        currentMonthApiCallCount: 999, // beginner なら超過、expert は無視
      }) as never,
    );
    const call = vi.fn().mockResolvedValue({ result: 'ok' });

    const result = await withMeteredLLM(
      {
        featureUnit: 'project-upsert',
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
        currentMonthApiCostJpy: 998,
        pricePerCallHaiku: 10, // ADR-0019 改定後の単価 (Expert ¥10/call)
        monthlyBudgetCapJpy: 1000, // 998 + 5 = 1003 > 1000 で拒否
      }) as never,
    );
    const call = vi.fn();

    const result = await withMeteredLLM(
      {
        featureUnit: 'project-upsert',
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
        pricePerCallHaiku: 10, // ADR-0019 改定後の単価 (Expert ¥10/call)
        monthlyBudgetCapJpy: 1000, // 990 + 10 = 1000 ちょうど (>= ではなく > なので通る)
      }) as never,
    );
    const call = vi.fn().mockResolvedValue({ result: 'ok' });

    const result = await withMeteredLLM(
      {
        featureUnit: 'project-upsert',
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
        featureUnit: 'project-upsert',
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
        pricePerCallHaiku: 10, // plan 単価は ¥10 (ADR-0019 改定後)、ただし下記 predictedCostJpy が上書き
        monthlyBudgetCapJpy: 100,
      }) as never,
    );
    const call = vi.fn();

    // predictedCostJpy=20 を渡して 95+20>100 で拒否されることを確認
    const result = await withMeteredLLM(
      {
        // ADR-0019: 課金対象 featureUnit で predictedCostJpy override の動作を確認
        // (旧 'embedding-batch' は無料化されたため、billable な project-upsert で検証)
        featureUnit: 'project-upsert',
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
        featureUnit: 'project-upsert',
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
    // ADR-0019 (2026-05-24): Expert ¥5 → ¥10
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue(
      makeTenant({ plan: 'expert', pricePerCallHaiku: 10 }) as never,
    );
    const call = vi.fn().mockResolvedValue({ result: 'x' });

    const result = await withMeteredLLM(
      {
        featureUnit: 'project-upsert',
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
    // 2026-05-15 価格改定: Pro ¥30 → ¥15 / ADR-0019 (2026-05-24): Pro ¥15 据置
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue(
      makeTenant({ plan: 'pro', pricePerCallSonnet: 15 }) as never,
    );
    const call = vi.fn().mockResolvedValue({ result: 'x' });

    const result = await withMeteredLLM(
      {
        featureUnit: 'project-upsert',
        tenantId: TENANT_ID,
        userId: USER_ID,
        rateLimiter: allowAllRateLimiter(),
      },
      call,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.modelName).toBe(LLM_MODELS.SONNET);
      expect(result.costJpy).toBe(15);
    }
  });

  it('increment と ApiCallLog 作成は単一 transaction で実行される (整合性担保)', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue(makeTenant() as never);
    const call = vi.fn().mockResolvedValue({ result: 'x' });

    await withMeteredLLM(
      {
        featureUnit: 'project-upsert',
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
        featureUnit: 'project-upsert',
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
        featureUnit: 'project-upsert',
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
        featureUnit: 'project-upsert',
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

// ================================================================
// PR-S6 (2026-05-14): credit_card テナントの Stripe Usage Record queue
// ================================================================

describe('withMeteredLLM - PR-S6: Stripe Usage Record queue 連携', () => {
  it('paymentMethod=invoice なら stripeUsageRecordQueue.create を呼ばない', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue(
      makeTenant({ plan: 'expert', paymentMethod: 'invoice' }) as never,
    );
    const call = vi.fn().mockResolvedValue({ result: 'x' });

    await withMeteredLLM(
      { featureUnit: 'project-upsert', tenantId: TENANT_ID, userId: USER_ID, rateLimiter: allowAllRateLimiter() },
      call,
    );

    expect(prisma.stripeUsageRecordQueue.create).not.toHaveBeenCalled();
  });

  it('[PR-V8] paymentMethod=credit_card かつ stripeCustomerId 設定済 (expert plan) なら haiku で enqueue', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue(
      makeTenant({
        plan: 'expert',
        paymentMethod: 'credit_card',
        stripeCustomerId: 'cus_test_xxx',
      }) as never,
    );
    const call = vi.fn().mockResolvedValue({ result: 'x' });

    await withMeteredLLM(
      { featureUnit: 'project-upsert', tenantId: TENANT_ID, userId: USER_ID, rateLimiter: allowAllRateLimiter() },
      call,
    );

    const enqueueCall = vi.mocked(prisma.stripeUsageRecordQueue.create).mock.calls[0]?.[0];
    expect(enqueueCall).toBeDefined();
    expect(enqueueCall?.data.tenantId).toBe(TENANT_ID);
    expect(enqueueCall?.data.callType).toBe('haiku');
    expect(enqueueCall?.data.quantity).toBe(1);
    // ApiCallLog.id (= 同じ transaction で create) と一致するはず
    const apiLogCall = vi.mocked(prisma.apiCallLog.create).mock.calls[0]?.[0];
    expect(enqueueCall?.data.apiCallLogId).toBe(apiLogCall?.data.id);
  });

  it('[PR-V8] paymentMethod=credit_card かつ pro plan なら sonnet で enqueue', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue(
      makeTenant({
        plan: 'pro',
        paymentMethod: 'credit_card',
        stripeCustomerId: 'cus_test_xxx',
      }) as never,
    );
    const call = vi.fn().mockResolvedValue({ result: 'x' });

    await withMeteredLLM(
      { featureUnit: 'project-upsert', tenantId: TENANT_ID, userId: USER_ID, rateLimiter: allowAllRateLimiter() },
      call,
    );

    const enqueueCall = vi.mocked(prisma.stripeUsageRecordQueue.create).mock.calls[0]?.[0];
    expect(enqueueCall?.data.callType).toBe('sonnet');
  });

  it('[PR-V8] paymentMethod=credit_card だが stripeCustomerId 未設定なら enqueue しない (= setup 未完了/不整合の保護)', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue(
      makeTenant({
        plan: 'expert',
        paymentMethod: 'credit_card',
        stripeCustomerId: null,
      }) as never,
    );
    const call = vi.fn().mockResolvedValue({ result: 'x' });

    await withMeteredLLM(
      { featureUnit: 'project-upsert', tenantId: TENANT_ID, userId: USER_ID, rateLimiter: allowAllRateLimiter() },
      call,
    );

    expect(prisma.stripeUsageRecordQueue.create).not.toHaveBeenCalled();
  });

  it('LLM 呼出失敗時 (llm_error) は enqueue しない (= LLM 失敗で課金しない原則)', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue(
      makeTenant({
        plan: 'expert',
        paymentMethod: 'credit_card',
        stripeCustomerId: 'cus_test_xxx',
      }) as never,
    );
    const call = vi.fn().mockRejectedValue(new Error('LLM down'));

    const result = await withMeteredLLM(
      { featureUnit: 'project-upsert', tenantId: TENANT_ID, userId: USER_ID, rateLimiter: allowAllRateLimiter() },
      call,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('llm_error');
    expect(prisma.stripeUsageRecordQueue.create).not.toHaveBeenCalled();
  });
});

// ================================================================
// ADR-0019 (2026-05-24): billable / free featureUnit 分岐
// ================================================================

describe('withMeteredLLM - ADR-0019 §billable / free 分岐', () => {
  describe('無料 featureUnit (chat-semantic-search / *-embedding / *-backfill / external-import-embedding)', () => {
    it('chat-semantic-search: costJpy=0 / counter +0 / Stripe queue 投入なし', async () => {
      vi.mocked(prisma.tenant.findFirst).mockResolvedValue(
        makeTenant({
          plan: 'expert',
          paymentMethod: 'credit_card',
          stripeCustomerId: 'cus_test_xxx',
          pricePerCallHaiku: 10,
          currentMonthApiCallCount: 0,
          currentMonthApiCostJpy: 0,
        }) as never,
      );
      const call = vi.fn().mockResolvedValue({ result: 'x' });

      const result = await withMeteredLLM(
        {
          featureUnit: 'chat-semantic-search',
          tenantId: TENANT_ID,
          userId: USER_ID,
          rateLimiter: allowAllRateLimiter(),
        },
        call,
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.costJpy).toBe(0);
      }
      // Tenant counter は不変 (transaction の operations 配列に prisma.tenant.update が含まれない)
      expect(prisma.tenant.update).not.toHaveBeenCalled();
      // Stripe queue にも投入しない (= 無料 featureUnit なので)
      expect(prisma.stripeUsageRecordQueue.create).not.toHaveBeenCalled();
      // ApiCallLog は cost=0 で記録される (= 監査・分析・fair-use-limit カウント用)
      const logCall = vi.mocked(prisma.apiCallLog.create).mock.calls[0]?.[0];
      expect(logCall?.data.costJpy).toBe(0);
      expect(logCall?.data.featureUnit).toBe('chat-semantic-search');
    });

    it('knowledge-embedding: 同様に無料 (counter +0 / queue なし / cost=0 記録)', async () => {
      vi.mocked(prisma.tenant.findFirst).mockResolvedValue(
        makeTenant({ plan: 'pro' }) as never,
      );
      const call = vi.fn().mockResolvedValue({ result: 'x' });

      const result = await withMeteredLLM(
        {
          featureUnit: 'knowledge-embedding',
          tenantId: TENANT_ID,
          userId: USER_ID,
          rateLimiter: allowAllRateLimiter(),
        },
        call,
      );

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.costJpy).toBe(0);
      expect(prisma.tenant.update).not.toHaveBeenCalled();
    });

    it('Beginner ユーザでも無料 featureUnit は上限 50 を消費しない (= 上限到達後も継続実行可能)', async () => {
      // Beginner ユーザが currentMonthApiCallCount=50 (= 上限到達済) でも、無料 call は通る
      vi.mocked(prisma.tenant.findFirst).mockResolvedValue(
        makeTenant({
          plan: 'beginner',
          beginnerMonthlyCallLimit: 50, // ADR-0019: default 50
          currentMonthApiCallCount: 50, // 上限到達
        }) as never,
      );
      const call = vi.fn().mockResolvedValue({ result: 'x' });

      const result = await withMeteredLLM(
        {
          featureUnit: 'chat-semantic-search', // 無料 featureUnit
          tenantId: TENANT_ID,
          userId: USER_ID,
          rateLimiter: allowAllRateLimiter(),
        },
        call,
      );

      // 無料 featureUnit なので Beginner 上限超過状態でも実行可能
      expect(result.ok).toBe(true);
      expect(call).toHaveBeenCalled();
    });

    it('Beginner ユーザで billable featureUnit (project-upsert) は 50 上限で beginner_limit_exceeded', async () => {
      vi.mocked(prisma.tenant.findFirst).mockResolvedValue(
        makeTenant({
          plan: 'beginner',
          beginnerMonthlyCallLimit: 50,
          currentMonthApiCallCount: 50,
        }) as never,
      );
      const call = vi.fn();

      const result = await withMeteredLLM(
        {
          featureUnit: 'project-upsert', // billable
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
  });

  describe('課金対象 featureUnit (project-upsert / suggestion-explanation / auto-tag-extract)', () => {
    it('Pro suggestion-explanation: sonnet で Stripe queue 投入される', async () => {
      vi.mocked(prisma.tenant.findFirst).mockResolvedValue(
        makeTenant({
          plan: 'pro',
          paymentMethod: 'credit_card',
          stripeCustomerId: 'cus_test_xxx',
        }) as never,
      );
      const call = vi.fn().mockResolvedValue({ result: 'x' });

      await withMeteredLLM(
        {
          featureUnit: 'suggestion-explanation',
          tenantId: TENANT_ID,
          userId: USER_ID,
          rateLimiter: allowAllRateLimiter(),
        },
        call,
      );

      const enqueueCall = vi.mocked(prisma.stripeUsageRecordQueue.create).mock.calls[0]?.[0];
      expect(enqueueCall?.data.callType).toBe('sonnet');
    });

    it('Expert project-upsert: 単価 ¥10 で課金 (ADR-0019)', async () => {
      vi.mocked(prisma.tenant.findFirst).mockResolvedValue(
        makeTenant({
          plan: 'expert',
          pricePerCallHaiku: 10, // ADR-0019 default
        }) as never,
      );
      const call = vi.fn().mockResolvedValue({ result: 'x' });

      const result = await withMeteredLLM(
        {
          featureUnit: 'project-upsert',
          tenantId: TENANT_ID,
          userId: USER_ID,
          rateLimiter: allowAllRateLimiter(),
        },
        call,
      );

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.costJpy).toBe(10);
    });
  });

  describe('mid-month 単価変更: ADR-0019 migration 直後の新旧混在シナリオ', () => {
    it('Tenant.pricePerCallHaiku の現在値で costJpy が決定 (migration 直後でも整合)', async () => {
      // migration で pricePerCallHaiku が 5→10 に変わった直後を想定。
      // Tenant 行は新単価 (10) を持ち、新規 call はその単価で記録される。
      // 既存の ApiCallLog (旧単価 ¥5 で記録済) は immutable で SUM に新旧混在する設計。
      vi.mocked(prisma.tenant.findFirst).mockResolvedValue(
        makeTenant({
          plan: 'expert',
          pricePerCallHaiku: 10,
          currentMonthApiCostJpy: 25,
          currentMonthApiCallCount: 5,
        }) as never,
      );
      const call = vi.fn().mockResolvedValue({ result: 'x' });

      const result = await withMeteredLLM(
        {
          featureUnit: 'project-upsert',
          tenantId: TENANT_ID,
          userId: USER_ID,
          rateLimiter: allowAllRateLimiter(),
        },
        call,
      );

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.costJpy).toBe(10);
      const tenantUpdate = vi.mocked(prisma.tenant.update).mock.calls[0]?.[0];
      expect(tenantUpdate?.data?.currentMonthApiCostJpy).toEqual({ increment: 10 });
    });

    it('カスタム単価テナント (Enterprise 個別契約等) は migration で書き換えられず維持', async () => {
      // migration WHERE 句: `WHERE price_per_call_haiku = 5` のため、カスタム単価 (例 ¥20) は維持
      vi.mocked(prisma.tenant.findFirst).mockResolvedValue(
        makeTenant({
          plan: 'expert',
          pricePerCallHaiku: 20,
        }) as never,
      );
      const call = vi.fn().mockResolvedValue({ result: 'x' });

      const result = await withMeteredLLM(
        {
          featureUnit: 'project-upsert',
          tenantId: TENANT_ID,
          userId: USER_ID,
          rateLimiter: allowAllRateLimiter(),
        },
        call,
      );

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.costJpy).toBe(20);
    });
  });

  describe('fair-use-limit (Step 3.5): 無料 featureUnit の月次上限', () => {
    it('hard limit (10,000 calls) 到達で fair_use_limit_exceeded', async () => {
      vi.mocked(prisma.tenant.findFirst).mockResolvedValue(
        makeTenant({ plan: 'expert' }) as never,
      );
      // fair-use-limit の count を 10,000 で返す (= hard limit 到達)
      vi.mocked(prisma.apiCallLog.count).mockResolvedValueOnce(10_000);
      const call = vi.fn();

      const result = await withMeteredLLM(
        {
          featureUnit: 'chat-semantic-search',
          tenantId: TENANT_ID,
          userId: USER_ID,
          rateLimiter: allowAllRateLimiter(),
        },
        call,
      );

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('fair_use_limit_exceeded');
      expect(call).not.toHaveBeenCalled();
    });

    it('billable featureUnit は fair-use-limit を check しない (= 通常の budget cap で防御)', async () => {
      vi.mocked(prisma.tenant.findFirst).mockResolvedValue(
        makeTenant({ plan: 'expert' }) as never,
      );
      vi.mocked(prisma.apiCallLog.count).mockResolvedValueOnce(10_000); // 仮に超過していても
      const call = vi.fn().mockResolvedValue({ result: 'x' });

      const result = await withMeteredLLM(
        {
          featureUnit: 'project-upsert', // billable
          tenantId: TENANT_ID,
          userId: USER_ID,
          rateLimiter: allowAllRateLimiter(),
        },
        call,
      );

      expect(result.ok).toBe(true);
      // billable なので fair-use-limit の count は呼ばれない
      expect(prisma.apiCallLog.count).not.toHaveBeenCalled();
    });
  });
});
