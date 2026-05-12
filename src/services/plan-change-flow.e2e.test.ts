/**
 * プラン変更 + 月次 cron の e2e (統合) テスト (P-E / 2026-05-08)
 *
 * 役割:
 *   `tenant-self.service`(プラン変更) と `tenant-monthly-reset.service`(月初 cron) を組み合わせた
 *   月跨ぎシナリオを単一テストで通しで検証する。これまでは個別の unit test しかなく、
 *   「アップグレードが即時、ダウングレードが月跨ぎで適用される」一連の流れを e2e で再現できていなかった。
 *
 * 検証シナリオ (M1 → M2 → M3):
 *   - M1: Beginner プランで API 呼出 30 回 → ¥0 (Beginner は無料)
 *   - M1 後半: Beginner → Expert アップグレード (即時反映、beginnerEverUpgraded=true)
 *   - M1 後半: Expert で API 呼出 5 回 → ¥50 (¥10/call × 5)
 *   - M2 月初 cron:
 *       - snapshot に M1 最終状態 (35 回, ¥50, plan=expert) が保存される
 *       - currentMonth* カウンタが 0 にリセットされる
 *       - lastResetAt が M2 月初 UTC に進む
 *   - M2 中: Expert → Pro アップグレード (即時反映)
 *   - M2 中: Pro → Expert ダウングレード予約 (M3 月初 UTC 適用)
 *   - M2 中の補足検証: P-B (Beginner downgrade 禁止) で Beginner への変更が拒否される
 *   - M3 月初 cron:
 *       - 予約された Pro → Expert が apply される (plan=expert, scheduled* がクリア)
 *
 * 設計判断:
 *   - 実 DB は使わず、prisma mock を「テナント 1 行の in-memory state」として実装する。
 *     unit test の延長で書けるため CI 高速 + 環境変数依存ゼロ。
 *   - 時刻は vi.setSystemTime で UTC 固定 (テストごとに setUtc ヘルパで明示移動)。
 *
 * 関連:
 *   - 計画: docs/roadmap/V1_FINAL_TASKS.md P-E
 *   - サービス: src/services/tenant-self.service.ts (プラン変更)
 *             src/services/tenant-monthly-reset.service.ts (cron)
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const TENANT_ID = '00000000-0000-0000-0000-000000000099';

/** prisma mock の裏側で保持するテナント単一行の state */
type FakeTenant = {
  id: string;
  plan: 'beginner' | 'expert' | 'pro';
  currentMonthApiCallCount: number;
  currentMonthApiCostJpy: number;
  monthlyBudgetCapJpy: number | null;
  beginnerMonthlyCallLimit: number;
  beginnerMaxSeats: number;
  pricePerCallHaiku: number;
  pricePerCallSonnet: number;
  scheduledPlanChangeAt: Date | null;
  scheduledNextPlan: string | null;
  beginnerEverUpgraded: boolean;
  lastResetAt: Date | null;
  createdAt: Date;
  deletedAt: Date | null;
  // PR-4 (2026-05-15): テナント TZ
  timezone: string;
  // PR-3 / Storage add-on 関連 (本テストでは未使用だが型整合のため)
  storageAddonPlan: string;
  storageBytesUsed: bigint;
};

const initialState = (): FakeTenant => ({
  id: TENANT_ID,
  plan: 'beginner',
  currentMonthApiCallCount: 0,
  currentMonthApiCostJpy: 0,
  monthlyBudgetCapJpy: null,
  beginnerMonthlyCallLimit: 100,
  beginnerMaxSeats: 5,
  pricePerCallHaiku: 10,
  pricePerCallSonnet: 30,
  scheduledPlanChangeAt: null,
  scheduledNextPlan: null,
  beginnerEverUpgraded: false,
  lastResetAt: null,
  createdAt: new Date('2026-04-15T00:00:00Z'),
  deletedAt: null,
  // PR-4: UTC TZ で本テストの境界判定 (2026-06-01T00:00:00Z) が UTC ベースの旧仕様と一致
  timezone: 'UTC',
  storageAddonPlan: 'standard',
  storageBytesUsed: BigInt(0),
});

let state: FakeTenant;

/** 複数テナント想定の monthly_usage_history snapshot (key=yearMonth) */
const snapshots: Map<string, { apiCallCount: number; apiCostJpy: number; plan: string }> =
  new Map();

vi.mock('@/lib/db', () => ({
  prisma: {
    tenant: {
      findFirst: vi.fn(async ({ where }: { where: { id: string; deletedAt: null } }) => {
        if (where.id !== state.id) return null;
        if (state.deletedAt !== null) return null;
        return { ...state };
      }),
      findFirstOrThrow: vi.fn(async ({ where }: { where: { id: string; deletedAt: null } }) => {
        if (where.id !== state.id || state.deletedAt !== null) {
          throw new Error('Not found');
        }
        return { ...state };
      }),
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        // PR-4 (2026-05-15): mocks for tenant-monthly-reset (per-tenant TZ filtering 後の全テナント取得) +
        //   applyScheduledPlanChanges (scheduledPlanChangeAt 条件) を扱う。
        if (where.scheduledPlanChangeAt !== undefined) {
          // applyScheduledPlanChanges 用
          if (
            state.scheduledPlanChangeAt &&
            state.scheduledNextPlan &&
            (where.scheduledPlanChangeAt as { lte: Date }).lte >= state.scheduledPlanChangeAt
          ) {
            return [{ id: state.id, scheduledNextPlan: state.scheduledNextPlan }];
          }
          return [];
        }
        // saveMonthlyUsageSnapshots / resetTenantMonthlyCounters 用:
        //   今は WHERE で lastResetAt フィルタしないため、deletedAt=null かつ
        //   (id != MANAGEMENT_TENANT_ID または filter なし) のテナントを全件返す。
        //   サービス側で per-tenant TZ ベースに JS filter する。
        if (state.deletedAt !== null) return [];
        return [{ ...state }];
      }),
      updateMany: vi.fn(async () => {
        // PR-4: resetTenantMonthlyCounters は updateMany ではなく per-tenant update に変更されたため
        //   現在 updateMany は使われない。互換 stub として残置。
        return { count: 0 };
      }),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        for (const k of Object.keys(data)) {
          (state as unknown as Record<string, unknown>)[k] = data[k];
        }
        return { ...state };
      }),
    },
    user: {
      count: vi.fn(async () => 1), // 常に 1 名 (admin) で席数チェックは通る
      groupBy: vi.fn(async () => [{ tenantId: TENANT_ID, _count: { id: 1 } }]),
    },
    tenantMonthlyUsageHistory: {
      upsert: vi.fn(async ({ create }: { create: Record<string, unknown> }) => {
        snapshots.set(create.yearMonth as string, {
          apiCallCount: create.apiCallCount as number,
          apiCostJpy: create.apiCostJpy as number,
          plan: create.plan as string,
        });
        return create;
      }),
    },
  },
}));

vi.mock('@/services/error-log.service', () => ({
  recordError: vi.fn(),
}));

// P-B (beginner-expiry) のヘルパは値を返すだけで副作用なし
vi.mock('./beginner-expiry.service', async () => {
  const actual = await vi.importActual<typeof import('./beginner-expiry.service')>(
    './beginner-expiry.service',
  );
  return actual;
});

import { updateTenantSelf } from './tenant-self.service';
import { runTenantMonthlyReset } from './tenant-monthly-reset.service';

beforeEach(() => {
  state = initialState();
  snapshots.clear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function setUtc(iso: string): void {
  vi.setSystemTime(new Date(iso));
}

/** 1 件の API 呼出をシミュレート (実運用は withMeteredLLM が更新するが、本テストは単純化) */
function simulateApiCall(callCount: number): void {
  state.currentMonthApiCallCount += callCount;
  if (state.plan === 'beginner') {
    // Beginner は無料 (¥0/call)
    return;
  }
  const unitPrice = state.plan === 'pro' ? state.pricePerCallSonnet : state.pricePerCallHaiku;
  state.currentMonthApiCostJpy += unitPrice * callCount;
}

describe('プラン変更 e2e: M1 → M2 → M3 (P-E / 2026-05-08)', () => {
  it('Beginner で開始 → Expert アップグレード → 月跨ぎ → Pro アップグレード → Expert ダウングレード予約 → 翌月適用', async () => {
    // ============ M1 (2026-05) Beginner 期間 ============
    setUtc('2026-05-10T00:00:00Z');
    // M1 序盤: 30 回呼出 → Beginner 無料
    simulateApiCall(30);
    expect(state.plan).toBe('beginner');
    expect(state.currentMonthApiCallCount).toBe(30);
    expect(state.currentMonthApiCostJpy).toBe(0);

    // ============ M1 後半: Beginner → Expert アップグレード (即時) ============
    setUtc('2026-05-20T00:00:00Z');
    const upgradeResult = await updateTenantSelf(TENANT_ID, { plan: 'expert' });
    expect(upgradeResult.ok).toBe(true);
    if (upgradeResult.ok) {
      expect(upgradeResult.appliedImmediately).toBe(true);
    }
    expect(state.plan).toBe('expert');
    expect(state.beginnerEverUpgraded).toBe(true);

    // M1 後半: Expert で 5 回呼出 → ¥50
    simulateApiCall(5);
    expect(state.currentMonthApiCallCount).toBe(35);
    expect(state.currentMonthApiCostJpy).toBe(50);

    // ============ M2 月初 cron (2026-06-01) ============
    setUtc('2026-06-01T00:00:00Z');
    const m2Cron = await runTenantMonthlyReset();
    expect(m2Cron.snapshotSavedCount).toBe(1);
    expect(m2Cron.resetCount).toBe(1);
    expect(m2Cron.planAppliedCount).toBe(0); // 予約なし

    // M1 (= 2026-05) のスナップショットが保存されている
    const m1Snapshot = snapshots.get('2026-05');
    expect(m1Snapshot).toEqual({
      apiCallCount: 35,
      apiCostJpy: 50,
      plan: 'expert',
    });

    // カウンタリセット + lastResetAt 進行
    expect(state.currentMonthApiCallCount).toBe(0);
    expect(state.currentMonthApiCostJpy).toBe(0);
    expect(state.lastResetAt?.toISOString()).toBe('2026-06-01T00:00:00.000Z');
    expect(state.plan).toBe('expert'); // プランは保持

    // ============ M2 中の Beginner ダウングレード試行 → P-B で禁止される ============
    setUtc('2026-06-10T00:00:00Z');
    const beginnerDowngrade = await updateTenantSelf(TENANT_ID, { plan: 'beginner' });
    expect(beginnerDowngrade.ok).toBe(false);
    if (!beginnerDowngrade.ok) {
      expect(beginnerDowngrade.error).toBe('BEGINNER_DOWNGRADE_FORBIDDEN');
    }
    // state は変わっていない
    expect(state.plan).toBe('expert');

    // ============ M2 中: Expert → Pro アップグレード (即時) ============
    const proUpgrade = await updateTenantSelf(TENANT_ID, { plan: 'pro' });
    expect(proUpgrade.ok).toBe(true);
    expect(state.plan).toBe('pro');

    // M2 中の Pro 呼出 → ¥30/call (Sonnet 単価)
    simulateApiCall(2);
    expect(state.currentMonthApiCallCount).toBe(2);
    expect(state.currentMonthApiCostJpy).toBe(60);

    // ============ M2 後半: Pro → Expert ダウングレード予約 ============
    setUtc('2026-06-20T00:00:00Z');
    const downgradeResult = await updateTenantSelf(TENANT_ID, { plan: 'expert' });
    expect(downgradeResult.ok).toBe(true);
    if (downgradeResult.ok) {
      expect(downgradeResult.appliedImmediately).toBe(false); // 翌月適用
      expect(downgradeResult.scheduledFor?.toISOString()).toBe('2026-07-01T00:00:00.000Z');
    }
    // 即時反映ではないので plan はまだ pro
    expect(state.plan).toBe('pro');
    expect(state.scheduledNextPlan).toBe('expert');
    expect(state.scheduledPlanChangeAt?.toISOString()).toBe('2026-07-01T00:00:00.000Z');

    // ============ M3 月初 cron (2026-07-01) ============
    setUtc('2026-07-01T00:00:00Z');
    const m3Cron = await runTenantMonthlyReset();
    expect(m3Cron.snapshotSavedCount).toBe(1);
    expect(m3Cron.resetCount).toBe(1);
    expect(m3Cron.planAppliedCount).toBe(1); // ダウングレード予約適用!

    // M2 (= 2026-06) のスナップショットが保存されている (リセット前の値で)
    const m2Snapshot = snapshots.get('2026-06');
    expect(m2Snapshot).toEqual({
      apiCallCount: 2,
      apiCostJpy: 60,
      plan: 'pro', // 適用前の plan で記録される (重要)
    });

    // M3 開始時点: Expert へダウングレード適用済 + 予約クリア
    expect(state.plan).toBe('expert');
    expect(state.scheduledPlanChangeAt).toBeNull();
    expect(state.scheduledNextPlan).toBeNull();
    expect(state.currentMonthApiCallCount).toBe(0);
    expect(state.currentMonthApiCostJpy).toBe(0);

    // M3 序盤: Expert で呼出 → ¥10/call で課金される
    simulateApiCall(3);
    expect(state.currentMonthApiCallCount).toBe(3);
    expect(state.currentMonthApiCostJpy).toBe(30);
  });

  it('cron が同日に二度実行されても冪等 (lastResetAt が当月初なので 0 件)', async () => {
    setUtc('2026-06-01T00:00:00Z');
    const first = await runTenantMonthlyReset();
    expect(first.resetCount).toBe(1);

    const second = await runTenantMonthlyReset();
    expect(second.resetCount).toBe(0);
    expect(second.snapshotSavedCount).toBe(0);
  });

  it('予約ダウングレードを M2 中にキャンセル → M3 cron で適用されない', async () => {
    setUtc('2026-06-10T00:00:00Z');
    // Pro までアップグレード
    await updateTenantSelf(TENANT_ID, { plan: 'expert' });
    await updateTenantSelf(TENANT_ID, { plan: 'pro' });
    // Pro → Expert ダウングレード予約
    await updateTenantSelf(TENANT_ID, { plan: 'expert' });
    expect(state.scheduledNextPlan).toBe('expert');

    // 予約をキャンセル (cancelScheduledPlanChange は state.scheduledPlanChangeAt = null にする)
    const { cancelScheduledPlanChange } = await import('./tenant-self.service');
    await cancelScheduledPlanChange(TENANT_ID);
    expect(state.scheduledPlanChangeAt).toBeNull();
    expect(state.scheduledNextPlan).toBeNull();

    // M3 月初 cron → ダウングレード適用なし
    setUtc('2026-07-01T00:00:00Z');
    const m3Cron = await runTenantMonthlyReset();
    expect(m3Cron.planAppliedCount).toBe(0);
    expect(state.plan).toBe('pro'); // Pro のまま
  });
});
