/**
 * テナントストレージ管理サービスの単体テスト (Phase 2 / 2026-05-08)
 *
 * 検証項目:
 *   - getStorageInfo: 正常系 (使用量・上限・課金) + Grace state 判定
 *   - isStorageWriteBlocked: pure 関数の境界条件 (7 日経過判定)
 *   - updateStorageAddonPlan: アップグレード即時 / ダウングレード予約 / 使用量超過拒否 / 同一プラン noop
 *   - cancelScheduledStorageAddon: 予約クリア
 *   - checkAndStartGracePeriod: 開始 / クリア / 上限内テナントは noop
 *   - applyScheduledStorageChanges: 月初予約適用 / 月跨ぎでデータ増 → skip
 *   - calculateTenantStorageBytes: pg_column_size 集計の戻り値型
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  prisma: {
    tenant: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
    $queryRaw: vi.fn(),
  },
}));

vi.mock('@/services/error-log.service', () => ({
  recordError: vi.fn(),
}));

import {
  getStorageInfo,
  isStorageWriteBlocked,
  updateStorageAddonPlan,
  cancelScheduledStorageAddon,
  checkAndStartGracePeriod,
  applyScheduledStorageChanges,
  calculateTenantStorageBytes,
  updateAllStorageBytesUsed,
  updateStorageBytesUsedForTenant,
} from './tenant-storage.service';
import { prisma } from '@/lib/db';
import { recordError } from '@/services/error-log.service';

const TENANT_ID = 'tenant-uuid-1';
const ONE_MB = 1024 * 1024;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getStorageInfo', () => {
  it('Standard プランの正常系 (全プラン共通 20MB 上限、使用量 10MB → 50%、Grace=active)', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue({
      id: TENANT_ID,
      plan: 'beginner',
      storageAddonPlan: 'standard',
      storageBytesUsed: BigInt(10 * ONE_MB),
      storageBytesUsedAt: new Date('2026-05-08T00:00:00Z'),
      storageGracePeriodStartedAt: null,
      scheduledStorageAddonAt: null,
      scheduledNextStorageAddon: null,
    } as never);

    const info = await getStorageInfo(TENANT_ID);
    expect(info).not.toBeNull();
    if (info) {
      expect(info.llmPlan).toBe('beginner');
      expect(info.storageAddonPlan).toBe('standard');
      expect(info.storageBytesUsed).toBe(10 * ONE_MB);
      // PR-3 (2026-05-15): 20MB 共通
      expect(info.storageLimitBytes).toBe(20 * ONE_MB);
      expect(info.usageRatio).toBeCloseTo(0.5);
      expect(info.graceState).toBe('active');
      expect(info.storageAddonMonthlyJpy).toBe(0);
    }
  });

  it('PR-3: Plus プラン: 上限 = 20 + 200 = 220MB / 月額 ¥500 (LLM プラン非依存)', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue({
      id: TENANT_ID,
      plan: 'expert',
      storageAddonPlan: 'plus',
      storageBytesUsed: BigInt(0),
      storageBytesUsedAt: null,
      storageGracePeriodStartedAt: null,
      scheduledStorageAddonAt: null,
      scheduledNextStorageAddon: null,
    } as never);

    const info = await getStorageInfo(TENANT_ID);
    if (info) {
      expect(info.storageLimitBytes).toBe(220 * ONE_MB);
      expect(info.storageAddonMonthlyJpy).toBe(500);
    }
  });

  it('PR-3: Pro Storage プラン: 上限 = 20 + 1000 = 1020MB / 月額 ¥1500', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue({
      id: TENANT_ID,
      plan: 'beginner',
      storageAddonPlan: 'pro_storage',
      storageBytesUsed: BigInt(0),
      storageBytesUsedAt: null,
      storageGracePeriodStartedAt: null,
      scheduledStorageAddonAt: null,
      scheduledNextStorageAddon: null,
    } as never);

    const info = await getStorageInfo(TENANT_ID);
    if (info) {
      expect(info.storageLimitBytes).toBe(1020 * ONE_MB);
      expect(info.storageAddonMonthlyJpy).toBe(1500);
    }
  });

  it('PR-3: Enterprise プラン: 上限 = 20 + 5000 = 5020MB / 月額 ¥5000', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue({
      id: TENANT_ID,
      plan: 'pro',
      storageAddonPlan: 'enterprise',
      storageBytesUsed: BigInt(0),
      storageBytesUsedAt: null,
      storageGracePeriodStartedAt: null,
      scheduledStorageAddonAt: null,
      scheduledNextStorageAddon: null,
    } as never);

    const info = await getStorageInfo(TENANT_ID);
    if (info) {
      expect(info.storageLimitBytes).toBe(5020 * ONE_MB);
      expect(info.storageAddonMonthlyJpy).toBe(5000);
    }
  });

  it('Grace 開始 3 日経過 → graceState=grace_active、残り 4 日', async () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue({
      id: TENANT_ID,
      plan: 'beginner',
      storageAddonPlan: 'standard',
      storageBytesUsed: BigInt(30 * ONE_MB), // 20MB 超過
      storageBytesUsedAt: null,
      storageGracePeriodStartedAt: threeDaysAgo,
      scheduledStorageAddonAt: null,
      scheduledNextStorageAddon: null,
    } as never);

    const info = await getStorageInfo(TENANT_ID);
    if (info) {
      expect(info.graceState).toBe('grace_active');
      expect(info.graceDaysRemaining).toBe(4);
    }
  });

  it('Grace 開始 8 日経過 → graceState=write_blocked', async () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue({
      id: TENANT_ID,
      plan: 'beginner',
      storageAddonPlan: 'standard',
      storageBytesUsed: BigInt(30 * ONE_MB),
      storageBytesUsedAt: null,
      storageGracePeriodStartedAt: eightDaysAgo,
      scheduledStorageAddonAt: null,
      scheduledNextStorageAddon: null,
    } as never);

    const info = await getStorageInfo(TENANT_ID);
    if (info) {
      expect(info.graceState).toBe('write_blocked');
    }
  });

  it('テナント不在 → null', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue(null);
    const info = await getStorageInfo('not-found');
    expect(info).toBeNull();
  });
});

describe('isStorageWriteBlocked (pure 関数)', () => {
  const FIXED_NOW = new Date('2026-05-15T12:00:00Z');

  it('Grace 未開始 → false', () => {
    expect(
      isStorageWriteBlocked({ storageGracePeriodStartedAt: null, now: FIXED_NOW }),
    ).toBe(false);
  });

  it('Grace 6 日 23 時間経過 → false (まだ猶予中)', () => {
    const start = new Date(FIXED_NOW.getTime() - (7 * 24 * 60 * 60 * 1000 - 60 * 60 * 1000));
    expect(
      isStorageWriteBlocked({ storageGracePeriodStartedAt: start, now: FIXED_NOW }),
    ).toBe(false);
  });

  it('Grace 7 日経過 → true', () => {
    const start = new Date(FIXED_NOW.getTime() - 7 * 24 * 60 * 60 * 1000);
    expect(
      isStorageWriteBlocked({ storageGracePeriodStartedAt: start, now: FIXED_NOW }),
    ).toBe(true);
  });

  it('Grace 30 日経過 → true', () => {
    const start = new Date(FIXED_NOW.getTime() - 30 * 24 * 60 * 60 * 1000);
    expect(
      isStorageWriteBlocked({ storageGracePeriodStartedAt: start, now: FIXED_NOW }),
    ).toBe(true);
  });
});

describe('updateStorageAddonPlan', () => {
  it('Standard → Plus アップグレード: 即時反映 + 予約クリア', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue({
      id: TENANT_ID,
      plan: 'expert',
      storageAddonPlan: 'standard',
      storageBytesUsed: BigInt(100 * ONE_MB),
    } as never);
    vi.mocked(prisma.tenant.update).mockResolvedValue({} as never);

    const r = await updateStorageAddonPlan(TENANT_ID, 'plus');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.appliedImmediately).toBe(true);
    expect(prisma.tenant.update).toHaveBeenCalledWith({
      where: { id: TENANT_ID },
      data: {
        storageAddonPlan: 'plus',
        scheduledStorageAddonAt: null,
        scheduledNextStorageAddon: null,
      },
    });
  });

  it('Plus → Standard ダウングレード: 翌月予約 (新上限 20MB 以内)', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue({
      id: TENANT_ID,
      plan: 'expert',
      storageAddonPlan: 'plus',
      storageBytesUsed: BigInt(10 * ONE_MB), // PR-3: Standard (20MB) 内なので OK
    } as never);
    vi.mocked(prisma.tenant.update).mockResolvedValue({} as never);

    const r = await updateStorageAddonPlan(TENANT_ID, 'standard');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.appliedImmediately).toBe(false);
      expect(r.scheduledFor).toBeInstanceOf(Date);
    }
  });

  it('Plus → Standard ダウングレードで使用量 > 新上限 → 拒否 (新上限 20MB)', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue({
      id: TENANT_ID,
      plan: 'expert',
      storageAddonPlan: 'plus',
      storageBytesUsed: BigInt(50 * ONE_MB), // PR-3: 20MB 超過
    } as never);

    const r = await updateStorageAddonPlan(TENANT_ID, 'standard');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('DOWNGRADE_BLOCKED_BY_USAGE');
    expect(prisma.tenant.update).not.toHaveBeenCalled();
  });

  it('同一プラン → noop で ok', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue({
      id: TENANT_ID,
      plan: 'beginner',
      storageAddonPlan: 'plus',
      storageBytesUsed: BigInt(0),
    } as never);

    const r = await updateStorageAddonPlan(TENANT_ID, 'plus');
    expect(r.ok).toBe(true);
    expect(prisma.tenant.update).not.toHaveBeenCalled();
  });

  it('テナント不在 → TENANT_NOT_FOUND', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue(null);
    const r = await updateStorageAddonPlan('not-found', 'plus');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('TENANT_NOT_FOUND');
  });
});

describe('cancelScheduledStorageAddon', () => {
  it('scheduled* を null クリア', async () => {
    vi.mocked(prisma.tenant.update).mockResolvedValue({} as never);
    await cancelScheduledStorageAddon(TENANT_ID);
    expect(prisma.tenant.update).toHaveBeenCalledWith({
      where: { id: TENANT_ID },
      data: { scheduledStorageAddonAt: null, scheduledNextStorageAddon: null },
    });
  });
});

describe('checkAndStartGracePeriod', () => {
  it('使用量 > 上限 かつ Grace 未開始 → Grace 開始 (PR-3: Standard 20MB)', async () => {
    vi.mocked(prisma.tenant.findMany).mockResolvedValue([
      {
        id: TENANT_ID,
        storageAddonPlan: 'standard',
        storageBytesUsed: BigInt(30 * ONE_MB), // PR-3: 20MB 超過
        storageGracePeriodStartedAt: null,
      },
    ] as never);
    vi.mocked(prisma.tenant.update).mockResolvedValue({} as never);

    const r = await checkAndStartGracePeriod();
    expect(r.graceStartedCount).toBe(1);
    expect(r.graceClearedCount).toBe(0);
  });

  it('使用量 ≤ 上限 かつ Grace 開始済 → Grace クリア', async () => {
    vi.mocked(prisma.tenant.findMany).mockResolvedValue([
      {
        id: TENANT_ID,
        storageAddonPlan: 'standard',
        storageBytesUsed: BigInt(15 * ONE_MB), // PR-3: 20MB 内
        storageGracePeriodStartedAt: new Date(),
      },
    ] as never);
    vi.mocked(prisma.tenant.update).mockResolvedValue({} as never);

    const r = await checkAndStartGracePeriod();
    expect(r.graceStartedCount).toBe(0);
    expect(r.graceClearedCount).toBe(1);
  });

  it('使用量 ≤ 上限 かつ Grace 未開始 → noop (PR-3: Plus 220MB)', async () => {
    vi.mocked(prisma.tenant.findMany).mockResolvedValue([
      {
        id: TENANT_ID,
        storageAddonPlan: 'plus',
        storageBytesUsed: BigInt(100 * ONE_MB), // 220MB 内
        storageGracePeriodStartedAt: null,
      },
    ] as never);

    const r = await checkAndStartGracePeriod();
    expect(r.graceStartedCount).toBe(0);
    expect(r.graceClearedCount).toBe(0);
    expect(prisma.tenant.update).not.toHaveBeenCalled();
  });
});

describe('applyScheduledStorageChanges', () => {
  it('予約済テナント: 使用量 ≤ 新上限 → 適用 (PR-3: Standard 20MB)', async () => {
    vi.mocked(prisma.tenant.findMany).mockResolvedValue([
      {
        id: TENANT_ID,
        storageAddonPlan: 'plus',
        storageBytesUsed: BigInt(10 * ONE_MB), // PR-3: Standard 20MB 内
        scheduledNextStorageAddon: 'standard',
      },
    ] as never);
    vi.mocked(prisma.tenant.update).mockResolvedValue({} as never);

    const r = await applyScheduledStorageChanges();
    expect(r.applied).toBe(1);
    expect(r.skippedDueToUsage).toBe(0);
  });

  it('予約済テナント: 使用量 > 新上限 → skip + 予約クリア (PR-3: Standard 20MB 超)', async () => {
    vi.mocked(prisma.tenant.findMany).mockResolvedValue([
      {
        id: TENANT_ID,
        storageAddonPlan: 'plus',
        storageBytesUsed: BigInt(50 * ONE_MB), // PR-3: Standard 20MB 超
        scheduledNextStorageAddon: 'standard',
      },
    ] as never);
    vi.mocked(prisma.tenant.update).mockResolvedValue({} as never);

    const r = await applyScheduledStorageChanges();
    expect(r.applied).toBe(0);
    expect(r.skippedDueToUsage).toBe(1);
  });
});

describe('calculateTenantStorageBytes', () => {
  it('$queryRaw の戻り値を BigInt で返す', async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValue([
      { total_bytes: BigInt(123456789) },
    ] as never);

    const result = await calculateTenantStorageBytes(TENANT_ID);
    expect(result).toBe(BigInt(123456789));
  });

  it('結果なし → 0n', async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValue([] as never);
    const result = await calculateTenantStorageBytes(TENANT_ID);
    expect(result).toBe(BigInt(0));
  });
});

describe('updateStorageBytesUsedForTenant (2026-05-14)', () => {
  it('正常系: テナント存在 → pg_column_size 集計値で書き戻して bigint を返す', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue({ id: TENANT_ID } as never);
    vi.mocked(prisma.$queryRaw).mockResolvedValue([
      { total_bytes: BigInt(771872) },
    ] as never);
    vi.mocked(prisma.tenant.update).mockResolvedValue({} as never);

    const result = await updateStorageBytesUsedForTenant(TENANT_ID);
    expect(result).toBe(BigInt(771872));
    expect(prisma.tenant.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: TENANT_ID },
        data: expect.objectContaining({
          storageBytesUsed: BigInt(771872),
          storageBytesUsedAt: expect.any(Date),
        }),
      }),
    );
  });

  it('テナント不在 (deletedAt=null フィルタで弾かれる) → null を返す + update を呼ばない', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue(null as never);
    const result = await updateStorageBytesUsedForTenant('non-existent');
    expect(result).toBeNull();
    expect(prisma.tenant.update).not.toHaveBeenCalled();
  });
});

describe('updateAllStorageBytesUsed (recordError 防御 — 2026-05-14)', () => {
  it('pg_column_size 失敗時に recordError 自体が throw しても処理継続', async () => {
    vi.mocked(prisma.tenant.findMany).mockResolvedValue([
      { id: 'tenant-a' },
      { id: 'tenant-b' },
    ] as never);
    // tenant-a の集計は失敗、tenant-b は成功
    vi.mocked(prisma.$queryRaw)
      .mockRejectedValueOnce(new Error('SQL error'))
      .mockResolvedValueOnce([{ total_bytes: BigInt(100) }] as never);
    // recordError が落ちても上位は止まらないことを検証
    vi.mocked(recordError).mockRejectedValueOnce(new Error('error_logs table missing'));
    vi.mocked(prisma.tenant.update).mockResolvedValue({} as never);

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const updated = await updateAllStorageBytesUsed();
    expect(updated).toBe(1); // tenant-b のみ成功
    // recordError が呼ばれたことを確認
    expect(recordError).toHaveBeenCalled();
    // recordError 失敗時に console.error にフォールバック
    expect(consoleSpy).toHaveBeenCalledWith(
      '[tenant-storage] recordError failed',
      expect.any(Error),
      'original:',
      expect.any(Error),
    );
    consoleSpy.mockRestore();
  });
});
