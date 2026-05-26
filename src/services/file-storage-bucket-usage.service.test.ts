/**
 * file-storage-bucket-usage.service の単体テスト (ADR-0021 / 2026-05-26)
 *
 * 検証観点:
 *   - calculateTenantBucketBytes: storage.objects 集計 + 失敗時 null フォールバック
 *   - calculateTenantAttachmentBytes: Attachment SUM (storageProvider='supabase' 限定)
 *   - syncTenantFileStorageUsage: bucket 優先 + peak MAX + level 昇格通知 + anomaly 検知
 *   - updateAllTenantFileStorageUsage: 全テナント一括 + storageFileBytesYesterday 更新
 *   - detectFileStorageDrift: drift 計算 + 50%/100% 通知
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => {
  const prismaMock = {
    tenant: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
    attachment: {
      aggregate: vi.fn(),
    },
    $queryRaw: vi.fn(),
  };
  return { prisma: prismaMock };
});

vi.mock('@/services/error-log.service', () => ({
  recordError: vi.fn(),
}));

import { prisma } from '@/lib/db';
import { recordError } from '@/services/error-log.service';
import {
  calculateTenantBucketBytes,
  calculateTenantAttachmentBytes,
  syncTenantFileStorageUsage,
  updateAllTenantFileStorageUsage,
  detectFileStorageDrift,
} from './file-storage-bucket-usage.service';
import {
  FILE_STORAGE_ANOMALY_DAILY_INCREASE_BYTES,
  SI_GB_BYTES,
  SI_MB_BYTES,
} from '@/config/file-storage-pricing';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('calculateTenantBucketBytes', () => {
  it('storage.objects 集計成功 → bigint を返す', async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValueOnce([
      { total_bytes: BigInt(500 * SI_MB_BYTES) },
    ] as never);

    const bytes = await calculateTenantBucketBytes(TENANT_ID);
    expect(bytes).toBe(BigInt(500 * SI_MB_BYTES));
  });

  it('結果 0 件 → 0n を返す (= 空配列でも安全)', async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValueOnce([] as never);
    const bytes = await calculateTenantBucketBytes(TENANT_ID);
    expect(bytes).toBe(BigInt(0));
  });

  it('storage.objects 不在 (権限なし / dev 環境) → null フォールバック', async () => {
    vi.mocked(prisma.$queryRaw).mockRejectedValueOnce(new Error('relation "storage.objects" does not exist'));
    const bytes = await calculateTenantBucketBytes(TENANT_ID);
    expect(bytes).toBeNull();
  });
});

describe('calculateTenantAttachmentBytes', () => {
  it('Attachment SUM (storageProvider="supabase" 限定)', async () => {
    vi.mocked(prisma.attachment.aggregate).mockResolvedValueOnce({
      _sum: { sizeBytes: BigInt(300 * SI_MB_BYTES) },
    } as never);

    const bytes = await calculateTenantAttachmentBytes(TENANT_ID);
    expect(bytes).toBe(BigInt(300 * SI_MB_BYTES));
    expect(prisma.attachment.aggregate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: TENANT_ID,
          storageProvider: 'supabase',
          deletedAt: null,
        }),
      }),
    );
  });

  it('SUM が null → 0n を返す', async () => {
    vi.mocked(prisma.attachment.aggregate).mockResolvedValueOnce({
      _sum: { sizeBytes: null },
    } as never);
    const bytes = await calculateTenantAttachmentBytes(TENANT_ID);
    expect(bytes).toBe(BigInt(0));
  });
});

describe('syncTenantFileStorageUsage — bucket 優先 + peak MAX', () => {
  it('bucket 集計成功 → bucket を採用 + peak MAX 更新', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce({
      id: TENANT_ID,
      storageFileBytesPeakThisMonth: BigInt(100 * SI_MB_BYTES),
      storageBucketBytesPeakThisMonth: BigInt(0),
      fileStorageWarningLevel: 'none',
      storageFileBytesYesterday: null,
    } as never);
    vi.mocked(prisma.$queryRaw).mockResolvedValueOnce([
      { total_bytes: BigInt(500 * SI_MB_BYTES) },
    ] as never);
    vi.mocked(prisma.attachment.aggregate).mockResolvedValueOnce({
      _sum: { sizeBytes: BigInt(450 * SI_MB_BYTES) },
    } as never);

    const r = await syncTenantFileStorageUsage(TENANT_ID);

    expect(r.usedBytes).toBe(BigInt(500 * SI_MB_BYTES));
    expect(r.bucketBytes).toBe(BigInt(500 * SI_MB_BYTES));
    expect(r.attachmentSumBytes).toBe(BigInt(450 * SI_MB_BYTES));
    expect(r.peakChanged).toBe(true);
    expect(prisma.tenant.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          storageFileBytesUsed: BigInt(500 * SI_MB_BYTES),
          storageFileBytesPeakThisMonth: BigInt(500 * SI_MB_BYTES),
        }),
      }),
    );
  });

  it('bucket 取得失敗 → Attachment SUM をフォールバック', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce({
      id: TENANT_ID,
      storageFileBytesPeakThisMonth: BigInt(0),
      storageBucketBytesPeakThisMonth: BigInt(0),
      fileStorageWarningLevel: 'none',
      storageFileBytesYesterday: null,
    } as never);
    vi.mocked(prisma.$queryRaw).mockRejectedValueOnce(new Error('storage.objects unavailable'));
    vi.mocked(prisma.attachment.aggregate).mockResolvedValueOnce({
      _sum: { sizeBytes: BigInt(200 * SI_MB_BYTES) },
    } as never);

    const r = await syncTenantFileStorageUsage(TENANT_ID);

    expect(r.usedBytes).toBe(BigInt(200 * SI_MB_BYTES));
    expect(r.bucketBytes).toBeNull();
  });

  it('peak は MAX で更新 (= 削除後でも巻き戻らない)', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce({
      id: TENANT_ID,
      storageFileBytesPeakThisMonth: BigInt(30 * SI_GB_BYTES),
      storageBucketBytesPeakThisMonth: BigInt(30 * SI_GB_BYTES),
      fileStorageWarningLevel: 'l2',
      storageFileBytesYesterday: null,
    } as never);
    vi.mocked(prisma.$queryRaw).mockResolvedValueOnce([
      { total_bytes: BigInt(20 * SI_GB_BYTES) },
    ] as never);
    vi.mocked(prisma.attachment.aggregate).mockResolvedValueOnce({
      _sum: { sizeBytes: BigInt(20 * SI_GB_BYTES) },
    } as never);

    const r = await syncTenantFileStorageUsage(TENANT_ID);

    expect(r.peakChanged).toBe(false);
    const updateCall = vi.mocked(prisma.tenant.update).mock.calls[0]?.[0] as {
      data: { storageFileBytesPeakThisMonth?: bigint };
    };
    expect(updateCall.data.storageFileBytesPeakThisMonth).toBeUndefined();
  });

  it('Level 昇格時に super_admin 通知 (none → l2)', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce({
      id: TENANT_ID,
      storageFileBytesPeakThisMonth: BigInt(0),
      storageBucketBytesPeakThisMonth: BigInt(0),
      fileStorageWarningLevel: 'none',
      storageFileBytesYesterday: null,
    } as never);
    vi.mocked(prisma.$queryRaw).mockResolvedValueOnce([
      { total_bytes: BigInt(15 * SI_GB_BYTES) },
    ] as never);
    vi.mocked(prisma.attachment.aggregate).mockResolvedValueOnce({
      _sum: { sizeBytes: BigInt(15 * SI_GB_BYTES) },
    } as never);

    const r = await syncTenantFileStorageUsage(TENANT_ID);

    expect(r.levelChanged).toBe(true);
    expect(r.newLevel).toBe('l2');
    expect(recordError).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: 'warn',
        context: expect.objectContaining({
          kind: 'file_storage_warning',
          newLevel: 'l2',
        }),
      }),
    );
  });

  it('anomaly: yesterday 比 +5GB 以上で warn 通知', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce({
      id: TENANT_ID,
      storageFileBytesPeakThisMonth: BigInt(0),
      storageBucketBytesPeakThisMonth: BigInt(0),
      fileStorageWarningLevel: 'none',
      storageFileBytesYesterday: BigInt(1 * SI_GB_BYTES),
    } as never);
    vi.mocked(prisma.$queryRaw).mockResolvedValueOnce([
      { total_bytes: BigInt(7 * SI_GB_BYTES) },
    ] as never);
    vi.mocked(prisma.attachment.aggregate).mockResolvedValueOnce({
      _sum: { sizeBytes: BigInt(7 * SI_GB_BYTES) },
    } as never);

    const r = await syncTenantFileStorageUsage(TENANT_ID);

    expect(r.anomalyDetected).toBe(true);
    expect(recordError).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({
          kind: 'file_storage_anomaly',
          tenantId: TENANT_ID,
        }),
      }),
    );
  });

  it('anomaly: yesterday=null は anomaly 判定しない (= 初日)', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce({
      id: TENANT_ID,
      storageFileBytesPeakThisMonth: BigInt(0),
      storageBucketBytesPeakThisMonth: BigInt(0),
      fileStorageWarningLevel: 'none',
      storageFileBytesYesterday: null,
    } as never);
    vi.mocked(prisma.$queryRaw).mockResolvedValueOnce([
      { total_bytes: BigInt(FILE_STORAGE_ANOMALY_DAILY_INCREASE_BYTES * 2) },
    ] as never);
    vi.mocked(prisma.attachment.aggregate).mockResolvedValueOnce({
      _sum: { sizeBytes: BigInt(FILE_STORAGE_ANOMALY_DAILY_INCREASE_BYTES * 2) },
    } as never);

    const r = await syncTenantFileStorageUsage(TENANT_ID);
    expect(r.anomalyDetected).toBe(false);
  });

  it('テナント不在 → Error throw', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce(null as never);
    await expect(syncTenantFileStorageUsage(TENANT_ID)).rejects.toThrow('Tenant not found');
  });
});

describe('updateAllTenantFileStorageUsage', () => {
  it('全テナントを同期 + storageFileBytesYesterday を当日値で baseline 更新', async () => {
    vi.mocked(prisma.tenant.findMany).mockResolvedValueOnce([
      { id: TENANT_ID },
      { id: '22222222-2222-2222-2222-222222222222' },
    ] as never);

    vi.mocked(prisma.tenant.findFirst)
      .mockResolvedValueOnce({
        id: TENANT_ID,
        storageFileBytesPeakThisMonth: BigInt(0),
        storageBucketBytesPeakThisMonth: BigInt(0),
        fileStorageWarningLevel: 'none',
        storageFileBytesYesterday: null,
      } as never)
      .mockResolvedValueOnce({
        id: '22222222-2222-2222-2222-222222222222',
        storageFileBytesPeakThisMonth: BigInt(0),
        storageBucketBytesPeakThisMonth: BigInt(0),
        fileStorageWarningLevel: 'none',
        storageFileBytesYesterday: null,
      } as never);

    vi.mocked(prisma.$queryRaw)
      .mockResolvedValueOnce([{ total_bytes: BigInt(100 * SI_MB_BYTES) }] as never)
      .mockResolvedValueOnce([{ total_bytes: BigInt(200 * SI_MB_BYTES) }] as never);

    vi.mocked(prisma.attachment.aggregate)
      .mockResolvedValueOnce({ _sum: { sizeBytes: BigInt(100 * SI_MB_BYTES) } } as never)
      .mockResolvedValueOnce({ _sum: { sizeBytes: BigInt(200 * SI_MB_BYTES) } } as never);

    const r = await updateAllTenantFileStorageUsage();

    expect(r.updatedCount).toBe(2);
    expect(r.anomalyCount).toBe(0);
    // baseline 更新呼出 = テナント数 × 2 (sync 内 update + baseline update) = 4
    expect(vi.mocked(prisma.tenant.update).mock.calls.length).toBe(4);
    const baselineCall = vi.mocked(prisma.tenant.update).mock.calls.find((c) => {
      const arg = c[0] as { data: Record<string, unknown> };
      return Object.keys(arg.data).length === 1 && 'storageFileBytesYesterday' in arg.data;
    });
    expect(baselineCall).toBeDefined();
  });

  it('1 テナント失敗で他のテナントは継続', async () => {
    vi.mocked(prisma.tenant.findMany).mockResolvedValueOnce([
      { id: TENANT_ID },
      { id: '22222222-2222-2222-2222-222222222222' },
    ] as never);

    // 1 件目: findFirst で fail
    vi.mocked(prisma.tenant.findFirst)
      .mockResolvedValueOnce(null as never)
      .mockResolvedValueOnce({
        id: '22222222-2222-2222-2222-222222222222',
        storageFileBytesPeakThisMonth: BigInt(0),
        storageBucketBytesPeakThisMonth: BigInt(0),
        fileStorageWarningLevel: 'none',
        storageFileBytesYesterday: null,
      } as never);

    vi.mocked(prisma.$queryRaw).mockResolvedValueOnce([
      { total_bytes: BigInt(100 * SI_MB_BYTES) },
    ] as never);
    vi.mocked(prisma.attachment.aggregate).mockResolvedValueOnce({
      _sum: { sizeBytes: BigInt(100 * SI_MB_BYTES) },
    } as never);

    const r = await updateAllTenantFileStorageUsage();

    expect(r.updatedCount).toBe(1);
    expect(recordError).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({ kind: 'file_storage_sync', tenantId: TENANT_ID }),
      }),
    );
  });
});

describe('detectFileStorageDrift', () => {
  it('attachment / bucket 一致 (drift 0%) → ok', async () => {
    vi.mocked(prisma.attachment.aggregate).mockResolvedValueOnce({
      _sum: { sizeBytes: BigInt(1 * SI_GB_BYTES) },
    } as never);
    vi.mocked(prisma.$queryRaw).mockResolvedValueOnce([
      { total_bytes: BigInt(1 * SI_GB_BYTES) },
    ] as never);

    const r = await detectFileStorageDrift();

    expect(r.driftRatio).toBe(0);
    expect(r.driftLevel).toBe('ok');
    expect(recordError).not.toHaveBeenCalled();
  });

  it('drift 60% → warning + recordError', async () => {
    vi.mocked(prisma.attachment.aggregate).mockResolvedValueOnce({
      _sum: { sizeBytes: BigInt(1 * SI_GB_BYTES) },
    } as never);
    vi.mocked(prisma.$queryRaw).mockResolvedValueOnce([
      { total_bytes: BigInt(1.6 * SI_GB_BYTES) },
    ] as never);

    const r = await detectFileStorageDrift();

    expect(r.driftLevel).toBe('warning');
    expect(recordError).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: 'warn',
        context: expect.objectContaining({ driftLevel: 'warning' }),
      }),
    );
  });

  it('drift 200% → critical + recordError', async () => {
    vi.mocked(prisma.attachment.aggregate).mockResolvedValueOnce({
      _sum: { sizeBytes: BigInt(1 * SI_GB_BYTES) },
    } as never);
    vi.mocked(prisma.$queryRaw).mockResolvedValueOnce([
      { total_bytes: BigInt(3 * SI_GB_BYTES) },
    ] as never);

    const r = await detectFileStorageDrift();

    expect(r.driftLevel).toBe('critical');
    expect(recordError).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: 'error',
        context: expect.objectContaining({ driftLevel: 'critical' }),
      }),
    );
  });

  it('bucket 取得失敗 → ok (drift 計算不可、warn ログのみ)', async () => {
    vi.mocked(prisma.attachment.aggregate).mockResolvedValueOnce({
      _sum: { sizeBytes: BigInt(1 * SI_GB_BYTES) },
    } as never);
    vi.mocked(prisma.$queryRaw).mockRejectedValueOnce(new Error('storage.objects unavailable'));

    const r = await detectFileStorageDrift();

    expect(r.driftLevel).toBe('ok');
    expect(recordError).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: 'warn',
        context: expect.objectContaining({ kind: 'file_storage_drift_detection' }),
      }),
    );
  });
});
