/**
 * テナントバナー サービスの単体テスト (ADR-0037)。
 *
 * 検証項目:
 *   - getActiveTenantBanner: 時間窓内の 1 件取得 / 無ければ null / DTO 整形 (Date→ISO)
 *   - listTenantBanners: 履歴一覧の整形 (テナントスコープ)
 *   - getTenantBanner: 所有権確認 (別テナントは null)
 *   - createTenantBanner: enabled なら重複期間を弾く / disabled はスキップ
 *   - updateTenantBanner: NOT_FOUND / INVALID_PERIOD / 重複は自身を除外 / 別テナント=NOT_FOUND
 *   - setTenantBannerEnabled: updateTenantBanner への委譲
 *   - deleteTenantBanner: 所有権確認 + 物理削除 / 別テナント=NOT_FOUND
 *   - テナント分離: 他テナントのデータにアクセスできない
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '@/lib/db';
import {
  getActiveTenantBanner,
  listTenantBanners,
  getTenantBanner,
  createTenantBanner,
  updateTenantBanner,
  setTenantBannerEnabled,
  deleteTenantBanner,
  TENANT_BANNER_OVERLAP_ERROR,
} from './tenant-banner.service';

vi.mock('@/lib/db', () => ({
  prisma: {
    tenantBanner: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  },
}));

const TENANT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const CREATED_BY = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const ISO_START = '2026-06-12T00:00:00.000Z';
const ISO_END = '2026-06-13T00:00:00.000Z';

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'banner-1',
    tenantId: TENANT_A,
    message: 'テナントバナーです',
    severity: 'high',
    startAt: new Date(ISO_START),
    endAt: new Date(ISO_END),
    enabled: true,
    createdBy: CREATED_BY,
    createdAt: new Date(ISO_START),
    updatedAt: new Date(ISO_START),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ================================================================
// getActiveTenantBanner
// ================================================================
describe('getActiveTenantBanner', () => {
  it('時間窓内のバナーを DTO (ISO 文字列) で返す', async () => {
    vi.mocked(prisma.tenantBanner.findFirst).mockResolvedValueOnce(row() as never);
    const dto = await getActiveTenantBanner(TENANT_A, new Date('2026-06-12T10:00:00.000Z'));
    expect(dto).toEqual({
      id: 'banner-1',
      tenantId: TENANT_A,
      message: 'テナントバナーです',
      severity: 'high',
      startAt: ISO_START,
      endAt: ISO_END,
      enabled: true,
      createdBy: CREATED_BY,
      createdAt: ISO_START,
      updatedAt: ISO_START,
    });
  });

  it('tenantId + enabled + start<=now<end の where 条件で取得する', async () => {
    vi.mocked(prisma.tenantBanner.findFirst).mockResolvedValueOnce(null as never);
    const now = new Date('2026-06-12T10:00:00.000Z');
    await getActiveTenantBanner(TENANT_A, now);
    expect(prisma.tenantBanner.findFirst).toHaveBeenCalledWith({
      where: { tenantId: TENANT_A, enabled: true, startAt: { lte: now }, endAt: { gt: now } },
      orderBy: { startAt: 'desc' },
    });
  });

  it('該当なしは null', async () => {
    vi.mocked(prisma.tenantBanner.findFirst).mockResolvedValueOnce(null as never);
    expect(await getActiveTenantBanner(TENANT_A, new Date())).toBeNull();
  });

  it('テナント分離: TENANT_B の tenantId で問い合わせると TENANT_A のバナーは返らない', async () => {
    // DB は TENANT_B 用バナーのみ返す (TENANT_A の行は WHERE で除外済み)
    vi.mocked(prisma.tenantBanner.findFirst).mockResolvedValueOnce(null as never);
    const result = await getActiveTenantBanner(TENANT_B, new Date('2026-06-12T10:00:00.000Z'));
    // 呼び出し条件が TENANT_B 限定であることを確認
    expect(prisma.tenantBanner.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ tenantId: TENANT_B }) }),
    );
    expect(result).toBeNull();
  });
});

// ================================================================
// listTenantBanners
// ================================================================
describe('listTenantBanners', () => {
  it('start_at 降順で同一テナントのバナーを DTO 化する', async () => {
    vi.mocked(prisma.tenantBanner.findMany).mockResolvedValueOnce(
      [row(), row({ id: 'banner-2' })] as never,
    );
    const list = await listTenantBanners(TENANT_A);
    expect(list).toHaveLength(2);
    expect(list[0].id).toBe('banner-1');
    expect(prisma.tenantBanner.findMany).toHaveBeenCalledWith({
      where: { tenantId: TENANT_A },
      orderBy: { startAt: 'desc' },
    });
  });
});

// ================================================================
// getTenantBanner
// ================================================================
describe('getTenantBanner', () => {
  it('対象が存在すれば DTO を返す', async () => {
    vi.mocked(prisma.tenantBanner.findFirst).mockResolvedValueOnce(row() as never);
    const dto = await getTenantBanner('banner-1', TENANT_A);
    expect(dto?.id).toBe('banner-1');
    expect(prisma.tenantBanner.findFirst).toHaveBeenCalledWith({
      where: { id: 'banner-1', tenantId: TENANT_A },
    });
  });

  it('テナント分離: 別テナントの ID を渡すと null', async () => {
    vi.mocked(prisma.tenantBanner.findFirst).mockResolvedValueOnce(null as never);
    const dto = await getTenantBanner('banner-1', TENANT_B);
    expect(dto).toBeNull();
    // WHERE に TENANT_B が含まれている
    expect(prisma.tenantBanner.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ tenantId: TENANT_B }) }),
    );
  });
});

// ================================================================
// createTenantBanner
// ================================================================
describe('createTenantBanner', () => {
  const data = {
    message: '新バナー',
    severity: 'medium' as const,
    startAt: new Date(ISO_START),
    endAt: new Date(ISO_END),
    enabled: true,
  };

  it('enabled で期間が重複しなければ作成できる', async () => {
    vi.mocked(prisma.tenantBanner.findFirst).mockResolvedValueOnce(null as never); // overlap なし
    vi.mocked(prisma.tenantBanner.create).mockResolvedValueOnce(
      row({ message: '新バナー', severity: 'medium', createdBy: CREATED_BY }) as never,
    );
    const dto = await createTenantBanner(data, TENANT_A, CREATED_BY);
    expect(dto.message).toBe('新バナー');
    // 重複チェックが同テナント内でのみ行われる
    expect(prisma.tenantBanner.findFirst).toHaveBeenCalledWith({
      where: {
        tenantId: TENANT_A,
        enabled: true,
        startAt: { lt: data.endAt },
        endAt: { gt: data.startAt },
      },
      select: { id: true },
    });
    expect(prisma.tenantBanner.create).toHaveBeenCalledOnce();
  });

  it('enabled で期間が重複すると TENANT_BANNER_OVERLAP で弾く', async () => {
    vi.mocked(prisma.tenantBanner.findFirst).mockResolvedValueOnce({ id: 'other' } as never);
    await expect(createTenantBanner(data, TENANT_A, CREATED_BY)).rejects.toThrow(
      TENANT_BANNER_OVERLAP_ERROR,
    );
    expect(prisma.tenantBanner.create).not.toHaveBeenCalled();
  });

  it('disabled (取り下げ状態) で作成するときは重複チェックをスキップする', async () => {
    vi.mocked(prisma.tenantBanner.create).mockResolvedValueOnce(
      row({ enabled: false }) as never,
    );
    await createTenantBanner({ ...data, enabled: false }, TENANT_A, CREATED_BY);
    expect(prisma.tenantBanner.findFirst).not.toHaveBeenCalled();
    expect(prisma.tenantBanner.create).toHaveBeenCalledOnce();
  });

  it('create に tenantId と createdBy が渡される', async () => {
    vi.mocked(prisma.tenantBanner.findFirst).mockResolvedValueOnce(null as never);
    vi.mocked(prisma.tenantBanner.create).mockResolvedValueOnce(row() as never);
    await createTenantBanner(data, TENANT_A, CREATED_BY);
    expect(prisma.tenantBanner.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ tenantId: TENANT_A, createdBy: CREATED_BY }),
    });
  });
});

// ================================================================
// updateTenantBanner
// ================================================================
describe('updateTenantBanner', () => {
  it('対象が存在しなければ NOT_FOUND', async () => {
    vi.mocked(prisma.tenantBanner.findFirst).mockResolvedValueOnce(null as never);
    await expect(updateTenantBanner('missing', { message: 'x' }, TENANT_A)).rejects.toThrow(
      'NOT_FOUND',
    );
  });

  it('テナント分離: 別テナントの ID を渡すと NOT_FOUND', async () => {
    // 別テナントでは findFirst が null を返す
    vi.mocked(prisma.tenantBanner.findFirst).mockResolvedValueOnce(null as never);
    await expect(updateTenantBanner('banner-1', { message: 'x' }, TENANT_B)).rejects.toThrow(
      'NOT_FOUND',
    );
  });

  it('start >= end になる更新は INVALID_PERIOD', async () => {
    vi.mocked(prisma.tenantBanner.findFirst).mockResolvedValueOnce(row() as never);
    await expect(
      updateTenantBanner('banner-1', { startAt: new Date(ISO_END), endAt: new Date(ISO_START) }, TENANT_A),
    ).rejects.toThrow('INVALID_PERIOD');
  });

  it('再有効化時の重複判定は自身を除外する', async () => {
    vi.mocked(prisma.tenantBanner.findFirst)
      .mockResolvedValueOnce(row({ enabled: false }) as never) // 既存取得
      .mockResolvedValueOnce(null as never); // overlap チェック
    vi.mocked(prisma.tenantBanner.update).mockResolvedValueOnce(row({ enabled: true }) as never);
    await updateTenantBanner('banner-1', { enabled: true }, TENANT_A);
    // overlap チェックが自身 (banner-1) と同テナントを除外して行われる
    expect(prisma.tenantBanner.findFirst).toHaveBeenNthCalledWith(2, {
      where: {
        tenantId: TENANT_A,
        enabled: true,
        id: { not: 'banner-1' },
        startAt: { lt: new Date(ISO_END) },
        endAt: { gt: new Date(ISO_START) },
      },
      select: { id: true },
    });
    expect(prisma.tenantBanner.update).toHaveBeenCalledOnce();
  });

  it('取り下げ (enabled=false) は重複チェックなしで更新する', async () => {
    vi.mocked(prisma.tenantBanner.findFirst).mockResolvedValueOnce(row() as never);
    vi.mocked(prisma.tenantBanner.update).mockResolvedValueOnce(row({ enabled: false }) as never);
    await setTenantBannerEnabled('banner-1', false, TENANT_A);
    // 1 回目の findFirst (既存取得) のみ; overlap チェックの findFirst は呼ばれない
    expect(prisma.tenantBanner.findFirst).toHaveBeenCalledOnce();
    expect(prisma.tenantBanner.update).toHaveBeenCalledOnce();
  });
});

// ================================================================
// deleteTenantBanner
// ================================================================
describe('deleteTenantBanner', () => {
  it('所有権確認後に物理削除する', async () => {
    vi.mocked(prisma.tenantBanner.findFirst).mockResolvedValueOnce(row() as never);
    vi.mocked(prisma.tenantBanner.delete).mockResolvedValueOnce(row() as never);
    await deleteTenantBanner('banner-1', TENANT_A);
    expect(prisma.tenantBanner.findFirst).toHaveBeenCalledWith({
      where: { id: 'banner-1', tenantId: TENANT_A },
    });
    expect(prisma.tenantBanner.delete).toHaveBeenCalledWith({ where: { id: 'banner-1' } });
  });

  it('テナント分離: 別テナントの ID を渡すと NOT_FOUND (削除されない)', async () => {
    vi.mocked(prisma.tenantBanner.findFirst).mockResolvedValueOnce(null as never);
    await expect(deleteTenantBanner('banner-1', TENANT_B)).rejects.toThrow('NOT_FOUND');
    expect(prisma.tenantBanner.delete).not.toHaveBeenCalled();
  });
});
