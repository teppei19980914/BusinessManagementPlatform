/**
 * import-storage-precheck.service の単体テスト (4 巡目フルスキャン / 2026-05-28)
 *
 * 検証観点:
 *   - estimateAddedBytes: エンティティ別の平均サイズ × 行数で正しく見積もる
 *   - precheckImportStorage:
 *     - Beginner プラン: 50MB 無料枠超過なら beginner-block
 *     - Expert/Pro: L1 (1GB) / L2 (10GB) で警告、L3 (50GB) でブロック
 *     - 全プラン共通: 50GB ハードキャップで l3-block
 *   - runImportStoragePrecheck: tenant.plan を読んで precheckImportStorage を呼び出す
 *     - blocker 時の errorBody 構築
 *     - 不明 plan は Beginner にフォールバック
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  prisma: {
    tenant: {
      findFirst: vi.fn(),
    },
  },
}));

import {
  AVG_BYTES_PER_IMPORTED_ROW,
  estimateAddedBytes,
  precheckImportStorage,
  runImportStoragePrecheck,
} from './import-storage-precheck.service';
import { prisma } from '@/lib/db';
import {
  DB_CAPACITY_FREE_TIER_BYTES,
  DB_CAPACITY_L1_USER_WARNING_BYTES,
  DB_CAPACITY_L2_ADMIN_ALERT_BYTES,
  DB_CAPACITY_L3_HARD_CAP_BYTES,
  SI_MB_BYTES,
  SI_GB_BYTES,
} from '@/config/db-capacity-pricing';

const TENANT_ID = '22222222-2222-2222-2222-222222222222';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('estimateAddedBytes', () => {
  it('単一エンティティの行数 × 平均サイズで計算', () => {
    expect(estimateAddedBytes([{ entity: 'knowledge', rowCount: 10 }])).toBe(
      10 * AVG_BYTES_PER_IMPORTED_ROW.knowledge,
    );
  });

  it('複数エンティティを合算する', () => {
    const result = estimateAddedBytes([
      { entity: 'knowledge', rowCount: 5 },
      { entity: 'risksIssues', rowCount: 3 },
    ]);
    expect(result).toBe(
      5 * AVG_BYTES_PER_IMPORTED_ROW.knowledge + 3 * AVG_BYTES_PER_IMPORTED_ROW.risksIssues,
    );
  });

  it('rowCount=0 でも 0 を返す (NaN にならない)', () => {
    expect(estimateAddedBytes([{ entity: 'memo', rowCount: 0 }])).toBe(0);
  });

  it('空配列は 0', () => {
    expect(estimateAddedBytes([])).toBe(0);
  });

  it('Task (WBS) は embedding なしで 1KB と最小', () => {
    expect(AVG_BYTES_PER_IMPORTED_ROW.task).toBe(1 * 1024);
    expect(AVG_BYTES_PER_IMPORTED_ROW.knowledge).toBeGreaterThan(
      AVG_BYTES_PER_IMPORTED_ROW.task,
    );
  });
});

describe('precheckImportStorage', () => {
  describe('無料枠内 (< 50MB)', () => {
    it('Beginner プランで取込後も 50MB 未満 → level=none', async () => {
      vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce({
        storageBytesUsed: BigInt(10 * SI_MB_BYTES),
      } as never);
      const r = await precheckImportStorage({
        tenantId: TENANT_ID,
        plan: 'beginner',
        estimatedAddedBytes: 5 * SI_MB_BYTES,
      });
      expect(r.level).toBe('none');
      expect(r.isBlocker).toBe(false);
      expect(r.code).toBe('OK');
      expect(r.expectedOverageJpy).toBe(0);
    });

    it('Expert プランで取込後も 50MB 未満 → level=none', async () => {
      vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce({
        storageBytesUsed: BigInt(20 * SI_MB_BYTES),
      } as never);
      const r = await precheckImportStorage({
        tenantId: TENANT_ID,
        plan: 'expert',
        estimatedAddedBytes: 10 * SI_MB_BYTES,
      });
      expect(r.level).toBe('none');
      expect(r.isBlocker).toBe(false);
    });
  });

  describe('Beginner プラン (50MB 超過は強制ブロック)', () => {
    it('取込後 50MB 超過 → beginner-block でブロック', async () => {
      vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce({
        storageBytesUsed: BigInt(40 * SI_MB_BYTES),
      } as never);
      const r = await precheckImportStorage({
        tenantId: TENANT_ID,
        plan: 'beginner',
        estimatedAddedBytes: 20 * SI_MB_BYTES,
      });
      expect(r.level).toBe('beginner-block');
      expect(r.isBlocker).toBe(true);
      expect(r.code).toBe('BEGINNER_FREE_QUOTA_EXCEEDED');
      expect(r.message).toContain('50MB');
      expect(r.expectedOverageJpy).toBe(0);
    });

    it('境界値 (= 50MB ちょうど) は無料枠内とみなしブロックしない', async () => {
      vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce({
        storageBytesUsed: BigInt(0),
      } as never);
      const r = await precheckImportStorage({
        tenantId: TENANT_ID,
        plan: 'beginner',
        estimatedAddedBytes: DB_CAPACITY_FREE_TIER_BYTES,
      });
      expect(r.level).toBe('none');
      expect(r.isBlocker).toBe(false);
    });

    it('既に 50MB 使用済で 1byte 追加 → ブロック', async () => {
      vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce({
        storageBytesUsed: BigInt(DB_CAPACITY_FREE_TIER_BYTES),
      } as never);
      const r = await precheckImportStorage({
        tenantId: TENANT_ID,
        plan: 'beginner',
        estimatedAddedBytes: 1,
      });
      expect(r.isBlocker).toBe(true);
      expect(r.level).toBe('beginner-block');
    });
  });

  describe('Expert / Pro プラン (L1/L2 警告、L3 ブロック)', () => {
    it('Expert で取込後 1GB 到達 → L1 警告 (ブロックしない)', async () => {
      vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce({
        storageBytesUsed: BigInt(0),
      } as never);
      const r = await precheckImportStorage({
        tenantId: TENANT_ID,
        plan: 'expert',
        estimatedAddedBytes: DB_CAPACITY_L1_USER_WARNING_BYTES,
      });
      expect(r.level).toBe('l1-warning');
      expect(r.isBlocker).toBe(false);
      expect(r.code).toBe('L1_WARNING');
      expect(r.expectedOverageJpy).toBeGreaterThan(0);
    });

    it('Pro で取込後 10GB 到達 → L2 警告 (ブロックしない)', async () => {
      vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce({
        storageBytesUsed: BigInt(5 * SI_GB_BYTES),
      } as never);
      const r = await precheckImportStorage({
        tenantId: TENANT_ID,
        plan: 'pro',
        estimatedAddedBytes: DB_CAPACITY_L2_ADMIN_ALERT_BYTES - 5 * SI_GB_BYTES,
      });
      expect(r.level).toBe('l2-warning');
      expect(r.isBlocker).toBe(false);
      expect(r.code).toBe('L2_WARNING');
      expect(r.message).toContain('10GB');
    });

    it('Expert で 50MB - 1GB の中間値 → level=none だが従量課金あり', async () => {
      vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce({
        storageBytesUsed: BigInt(0),
      } as never);
      const r = await precheckImportStorage({
        tenantId: TENANT_ID,
        plan: 'expert',
        estimatedAddedBytes: 500 * SI_MB_BYTES,
      });
      expect(r.level).toBe('none');
      expect(r.isBlocker).toBe(false);
      // 50MB 超過分は ¥50/GB tier で 1 tier 課金される
      expect(r.expectedOverageJpy).toBeGreaterThan(0);
    });
  });

  describe('累積ハードキャップ撤去後 (Expert/Pro は 50GB+ でもブロックしない) — ADR-0030', () => {
    it('Expert で取込後 50GB+ 到達 → ブロックせず l2-warning (累積上限撤去)', async () => {
      vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce({
        storageBytesUsed: BigInt(48 * SI_GB_BYTES),
      } as never);
      const r = await precheckImportStorage({
        tenantId: TENANT_ID,
        plan: 'expert',
        estimatedAddedBytes: 3 * SI_GB_BYTES,
      });
      expect(r.isBlocker).toBe(false);
      expect(r.level).toBe('l2-warning');
    });

    it('Pro で取込後 50GB 到達 → ブロックせず l2-warning (累積上限撤去)', async () => {
      vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce({
        storageBytesUsed: BigInt(DB_CAPACITY_L3_HARD_CAP_BYTES),
      } as never);
      const r = await precheckImportStorage({
        tenantId: TENANT_ID,
        plan: 'pro',
        estimatedAddedBytes: 0,
      });
      expect(r.isBlocker).toBe(false);
      expect(r.level).toBe('l2-warning');
    });
  });

  describe('テナント不在時', () => {
    it('テナントが見つからない → currentBytes=0 で計算継続', async () => {
      vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce(null);
      const r = await precheckImportStorage({
        tenantId: TENANT_ID,
        plan: 'expert',
        estimatedAddedBytes: 10 * SI_MB_BYTES,
      });
      expect(r.currentBytes).toBe(0);
      expect(r.level).toBe('none');
    });
  });
});

describe('runImportStoragePrecheck (route layer wrapper)', () => {
  it('正常系: plan を取得して precheck を実行', async () => {
    vi.mocked(prisma.tenant.findFirst)
      .mockResolvedValueOnce({ plan: 'expert' } as never)
      .mockResolvedValueOnce({ storageBytesUsed: BigInt(0) } as never);
    const r = await runImportStoragePrecheck({
      tenantId: TENANT_ID,
      entity: 'knowledge',
      newRowCount: 10,
    });
    expect(r.precheck).not.toBeNull();
    expect(r.isBlocker).toBe(false);
    expect(r.errorBody).toBeNull();
  });

  it('Beginner で 50MB 超過 → blocker + errorBody', async () => {
    vi.mocked(prisma.tenant.findFirst)
      .mockResolvedValueOnce({ plan: 'beginner' } as never)
      .mockResolvedValueOnce({
        storageBytesUsed: BigInt(60 * SI_MB_BYTES),
      } as never);
    const r = await runImportStoragePrecheck({
      tenantId: TENANT_ID,
      entity: 'knowledge',
      newRowCount: 10,
    });
    expect(r.isBlocker).toBe(true);
    expect(r.errorBody).not.toBeNull();
    expect(r.errorBody!.error.code).toBe('BEGINNER_FREE_QUOTA_EXCEEDED');
  });

  it('不明 plan は Beginner にフォールバック (= 厳しい側で安全)', async () => {
    vi.mocked(prisma.tenant.findFirst)
      .mockResolvedValueOnce({ plan: 'unknown_plan' } as never)
      .mockResolvedValueOnce({
        storageBytesUsed: BigInt(60 * SI_MB_BYTES),
      } as never);
    const r = await runImportStoragePrecheck({
      tenantId: TENANT_ID,
      entity: 'knowledge',
      newRowCount: 10,
    });
    expect(r.isBlocker).toBe(true);
    expect(r.errorBody!.error.code).toBe('BEGINNER_FREE_QUOTA_EXCEEDED');
  });

  it('テナント不在 → precheck=null で blocker なし', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce(null);
    const r = await runImportStoragePrecheck({
      tenantId: TENANT_ID,
      entity: 'knowledge',
      newRowCount: 10,
    });
    expect(r.precheck).toBeNull();
    expect(r.isBlocker).toBe(false);
    expect(r.errorBody).toBeNull();
  });

  it('estimatedAddedBytesOverride を指定すると entity / newRowCount を無視', async () => {
    vi.mocked(prisma.tenant.findFirst)
      .mockResolvedValueOnce({ plan: 'beginner' } as never)
      .mockResolvedValueOnce({
        storageBytesUsed: BigInt(0),
      } as never);
    const r = await runImportStoragePrecheck({
      tenantId: TENANT_ID,
      entity: 'knowledge',
      newRowCount: 1, // 無視される
      estimatedAddedBytesOverride: 60 * SI_MB_BYTES,
    });
    expect(r.precheck?.estimatedAddedBytes).toBe(60 * SI_MB_BYTES);
    expect(r.isBlocker).toBe(true);
  });
});
