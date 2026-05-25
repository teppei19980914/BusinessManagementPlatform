/**
 * プラン変更 + 月次 cron の e2e (統合) テスト (P-E / 2026-05-08)
 *
 * 役割:
 *   `tenant-self.service`(プラン変更) と `tenant-monthly-reset.service`(月初 cron) を組み合わせた
 *   月跨ぎシナリオを単一テストで通しで検証する。
 *
 * 検証シナリオ (M1 → M2 → M3):
 *   - M1: Beginner プランで API 呼出 30 回 → ¥0 (Beginner は無料)
 *   - M1 後半: Beginner → Expert アップグレード (即時反映、beginnerEverUpgraded=true)
 *   - M1 後半: Expert で API 呼出 5 回 → ¥25 (¥5/call × 5、2026-05-15 改定後)
 *   - M2 月初 cron:
 *       - snapshot に M1 最終状態 (35 回, ¥25, plan=expert) が保存される
 *       - currentMonth* カウンタが 0 にリセットされる
 *   - M2 中: Expert → Pro アップグレード (即時反映)
 *   - M2 中: Pro → Expert ダウングレード (**即時反映 / 2026-05-14 改修**)
 *     - 旧仕様では「翌月予約 + M3 cron 適用」だったが、業務仕様書 §F-13.11 と整合させ即時化。
 *     - 切替後の Expert 単価 ¥5/call で従量課金が継続することを検証 (2026-05-15 改定後)。
 *   - M2 中の補足検証: P-B (Beginner downgrade 禁止) で Beginner への変更が拒否される
 *   - M3 月初 cron:
 *       - snapshot 保存 + カウンタリセットは継続。
 *       - **planAppliedCount は 0** (Expert↔Pro 即時化により予約は発生しない)
 *       - legacy 予約レコード (旧 DB) があれば適用される動作自体は維持
 *
 * 設計判断:
 *   - 実 DB は使わず、prisma mock を「テナント 1 行の in-memory state」として実装する。
 *   - 時刻は vi.setSystemTime で UTC 固定 (テストごとに setUtc ヘルパで明示移動)。
 *
 * 関連:
 *   - 計画: docs/roadmap/V1_FINAL_TASKS.md P-E
 *   - サービス: src/services/tenant-self.service.ts (プラン変更)
 *             src/services/tenant-monthly-reset.service.ts (cron)
 *   - 業務仕様: docs/business/TENANT_AND_BILLING.md §F-13.11
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
  // ADR-0019 (2026-05-24): Beginner 上限 100 → 50、Expert 単価 ¥5 → ¥10、Pro ¥15 据置
  beginnerMonthlyCallLimit: 50,
  beginnerMaxSeats: 5,
  pricePerCallHaiku: 10,
  pricePerCallSonnet: 15,
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
      // PR-V8 (2026-05-19): resetTenantMonthlyCounters が systemUser を検索する。
      //   本テストでは null (= audit なしパス) を返して既存挙動と互換にする。
      findFirst: vi.fn(async () => null),
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
    auditLog: {
      create: vi.fn(),
    },
    $transaction: vi.fn(),
    // PR-V8.1 (2026-05-19): saveMonthlyUsageSnapshots は ApiCallLog SUM (真値) を使うように
    //   変更されたため mock を追加。本 e2e test では simulateApiCall が counter を直接更新する
    //   抽象モデルなので、aggregate は state の現在 counter 値を「前月の集計」として返す
    //   (= リセット前の値を snapshot に書く、というロジック検証として等価)。
    apiCallLog: {
      aggregate: vi.fn(async () => ({
        _count: { _all: state.currentMonthApiCallCount },
        _sum: { costJpy: state.currentMonthApiCostJpy },
      })),
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
  it('Beginner→Expert→月跨ぎ→Pro→Expert (即時) → M3 月跨ぎ (2026-05-14 即時化対応)', async () => {
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

    // M1 後半: Expert で 5 回呼出 → ¥50 (ADR-0019 で ¥10/call)
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
      apiCostJpy: 50, // ADR-0019: Expert ¥10/call × 5 calls = ¥50
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

    // M2 中の Pro 呼出 → ¥15/call (Sonnet 単価、2026-05-15 価格改定後)
    simulateApiCall(2);
    expect(state.currentMonthApiCallCount).toBe(2);
    expect(state.currentMonthApiCostJpy).toBe(30);

    // ============ M2 後半: Pro → Expert ダウングレード (2026-05-14 即時化) ============
    setUtc('2026-06-20T00:00:00Z');
    const downgradeResult = await updateTenantSelf(TENANT_ID, { plan: 'expert' });
    expect(downgradeResult.ok).toBe(true);
    if (downgradeResult.ok) {
      expect(downgradeResult.appliedImmediately).toBe(true); // 即時反映
      expect(downgradeResult.scheduledFor).toBeNull();
    }
    // 即時反映後: plan が expert に切り替わり、予約フィールドは null
    expect(state.plan).toBe('expert');
    expect(state.scheduledNextPlan).toBeNull();
    expect(state.scheduledPlanChangeAt).toBeNull();

    // ダウングレード後の M2 中の Expert 呼出 → ¥10/call (Haiku 単価、ADR-0019) で加算
    //   = 当月分は「Pro 期間 2 回 ¥30 + Expert 期間 3 回 ¥30」が混在記録される
    simulateApiCall(3);
    expect(state.currentMonthApiCallCount).toBe(5);
    expect(state.currentMonthApiCostJpy).toBe(60); // ¥30 (Pro) + ¥30 (Expert ¥10×3)

    // ============ M3 月初 cron (2026-07-01) ============
    setUtc('2026-07-01T00:00:00Z');
    const m3Cron = await runTenantMonthlyReset();
    expect(m3Cron.snapshotSavedCount).toBe(1);
    expect(m3Cron.resetCount).toBe(1);
    // 2026-05-14: Expert↔Pro 即時化により予約は発生しないため planAppliedCount=0
    expect(m3Cron.planAppliedCount).toBe(0);

    // M2 (= 2026-06) スナップショット: 即時ダウングレード後の最終状態 (plan=expert) で記録
    const m2Snapshot = snapshots.get('2026-06');
    expect(m2Snapshot).toEqual({
      apiCallCount: 5,
      apiCostJpy: 60, // ADR-0019: Pro ¥30 + Expert ¥10×3 = ¥60
      plan: 'expert', // 即時ダウングレード済なので Expert で記録される
    });

    // M3 開始時点: 既に Expert (M2 中に切替済) + カウンタリセット済
    expect(state.plan).toBe('expert');
    expect(state.scheduledPlanChangeAt).toBeNull();
    expect(state.scheduledNextPlan).toBeNull();
    expect(state.currentMonthApiCallCount).toBe(0);
    expect(state.currentMonthApiCostJpy).toBe(0);

    // M3 序盤: Expert で呼出 → ¥10/call で課金される (Haiku 単価、ADR-0019 改定後)
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

  // 2026-05-14 改修: Pro→Expert は即時反映に変更されたため、
  //   `updateTenantSelf` 経由で「ダウングレード予約」を作るパスは存在しない。
  //   ただし legacy DB レコードに残った scheduled* や、将来 Beginner downgrade が
  //   緩和されるケースに備え、cron + cancelScheduledPlanChange の defensive 経路を検証する。
  it('legacy 予約 (DB 直接セット相当) を M2 中にキャンセル → M3 cron で適用されない', async () => {
    setUtc('2026-06-10T00:00:00Z');
    // Pro までアップグレード
    await updateTenantSelf(TENANT_ID, { plan: 'expert' });
    await updateTenantSelf(TENANT_ID, { plan: 'pro' });

    // 旧仕様 (Pro→Expert で scheduled をセット) を模擬: 直接 state にダウングレード予約を埋め込む。
    // 実運用ではここに到達するレコードは旧 schema の遺物のみ。
    state.scheduledPlanChangeAt = new Date('2026-07-01T00:00:00Z');
    state.scheduledNextPlan = 'expert';

    // 予約をキャンセル
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

  // 2026-05-14: Pro→Expert 即時反映の追加検証 (単発ケース、月跨ぎ不要)
  it('Pro→Expert ダウングレードは即時反映される (scheduledFor=null / plan 即更新)', async () => {
    setUtc('2026-06-15T00:00:00Z');
    await updateTenantSelf(TENANT_ID, { plan: 'expert' });
    await updateTenantSelf(TENANT_ID, { plan: 'pro' });
    expect(state.plan).toBe('pro');

    const result = await updateTenantSelf(TENANT_ID, { plan: 'expert' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.appliedImmediately).toBe(true);
      expect(result.scheduledFor).toBeNull();
    }
    expect(state.plan).toBe('expert');
    expect(state.scheduledPlanChangeAt).toBeNull();
    expect(state.scheduledNextPlan).toBeNull();
  });
});
