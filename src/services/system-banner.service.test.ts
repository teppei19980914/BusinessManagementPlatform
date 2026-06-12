/**
 * システム周知バナー サービスの単体テスト (ADR-0036)。
 *
 * 検証項目:
 *   - getActiveBanner: 時間窓内の 1 件取得 / 無ければ null / DTO 整形 (Date→ISO)
 *   - listBanners: 履歴一覧の整形
 *   - createBanner: enabled なら重複期間を弾く / disabled なら重複チェックをスキップ
 *   - updateBanner: 不在=NOT_FOUND / start>=end=INVALID_PERIOD / 重複は自身を除外して判定
 *   - setBannerEnabled: update へ委譲
 *   - deleteBanner: 物理削除
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '@/lib/db';
import {
  getActiveBanner,
  listBanners,
  createBanner,
  updateBanner,
  setBannerEnabled,
  deleteBanner,
  BANNER_OVERLAP_ERROR,
} from './system-banner.service';

vi.mock('@/lib/db', () => ({
  prisma: {
    systemBanner: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  },
}));

const ISO_START = '2026-06-12T00:00:00.000Z';
const ISO_END = '2026-06-13T00:00:00.000Z';

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'banner-1',
    message: 'メンテナンスのお知らせ',
    severity: 'high',
    startAt: new Date(ISO_START),
    endAt: new Date(ISO_END),
    enabled: true,
    createdBy: '11111111-1111-1111-1111-111111111111',
    createdAt: new Date(ISO_START),
    updatedAt: new Date(ISO_START),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getActiveBanner', () => {
  it('時間窓内のバナーを DTO (ISO 文字列) で返す', async () => {
    vi.mocked(prisma.systemBanner.findFirst).mockResolvedValueOnce(row() as never);
    const dto = await getActiveBanner(new Date('2026-06-12T10:00:00.000Z'));
    expect(dto).toEqual({
      id: 'banner-1',
      message: 'メンテナンスのお知らせ',
      severity: 'high',
      startAt: ISO_START,
      endAt: ISO_END,
      enabled: true,
      createdBy: '11111111-1111-1111-1111-111111111111',
      createdAt: ISO_START,
      updatedAt: ISO_START,
    });
  });

  it('enabled かつ start<=now<end の where 条件で取得する', async () => {
    vi.mocked(prisma.systemBanner.findFirst).mockResolvedValueOnce(null as never);
    const now = new Date('2026-06-12T10:00:00.000Z');
    await getActiveBanner(now);
    expect(prisma.systemBanner.findFirst).toHaveBeenCalledWith({
      where: { enabled: true, startAt: { lte: now }, endAt: { gt: now } },
      orderBy: { startAt: 'desc' },
    });
  });

  it('該当なしは null', async () => {
    vi.mocked(prisma.systemBanner.findFirst).mockResolvedValueOnce(null as never);
    expect(await getActiveBanner(new Date())).toBeNull();
  });
});

describe('listBanners', () => {
  it('start_at 降順で全件を DTO 化する', async () => {
    vi.mocked(prisma.systemBanner.findMany).mockResolvedValueOnce([row(), row({ id: 'banner-2' })] as never);
    const list = await listBanners();
    expect(list).toHaveLength(2);
    expect(list[0].id).toBe('banner-1');
    expect(prisma.systemBanner.findMany).toHaveBeenCalledWith({ orderBy: { startAt: 'desc' } });
  });
});

describe('createBanner', () => {
  const data = {
    message: '新バナー',
    severity: 'medium' as const,
    startAt: new Date(ISO_START),
    endAt: new Date(ISO_END),
    enabled: true,
  };
  const createdBy = '22222222-2222-2222-2222-222222222222';

  it('enabled で期間が重複しなければ作成できる', async () => {
    vi.mocked(prisma.systemBanner.findFirst).mockResolvedValueOnce(null as never); // overlap なし
    vi.mocked(prisma.systemBanner.create).mockResolvedValueOnce(
      row({ message: '新バナー', severity: 'medium', createdBy }) as never,
    );
    const dto = await createBanner(data, createdBy);
    expect(dto.message).toBe('新バナー');
    // 重複判定が「enabled な既存と期間が重なるか」で問い合わされる
    expect(prisma.systemBanner.findFirst).toHaveBeenCalledWith({
      where: { enabled: true, startAt: { lt: data.endAt }, endAt: { gt: data.startAt } },
      select: { id: true },
    });
    expect(prisma.systemBanner.create).toHaveBeenCalledOnce();
  });

  it('enabled で期間が重複すると BANNER_OVERLAP で弾く (作成しない)', async () => {
    vi.mocked(prisma.systemBanner.findFirst).mockResolvedValueOnce({ id: 'other' } as never);
    await expect(createBanner(data, createdBy)).rejects.toThrow(BANNER_OVERLAP_ERROR);
    expect(prisma.systemBanner.create).not.toHaveBeenCalled();
  });

  it('disabled (取り下げ状態) で作成するときは重複チェックをスキップする', async () => {
    vi.mocked(prisma.systemBanner.create).mockResolvedValueOnce(row({ enabled: false }) as never);
    await createBanner({ ...data, enabled: false }, createdBy);
    expect(prisma.systemBanner.findFirst).not.toHaveBeenCalled();
    expect(prisma.systemBanner.create).toHaveBeenCalledOnce();
  });
});

describe('updateBanner', () => {
  it('対象が存在しなければ NOT_FOUND', async () => {
    vi.mocked(prisma.systemBanner.findUnique).mockResolvedValueOnce(null as never);
    await expect(updateBanner('missing', { message: 'x' })).rejects.toThrow('NOT_FOUND');
  });

  it('start >= end になる更新は INVALID_PERIOD', async () => {
    vi.mocked(prisma.systemBanner.findUnique).mockResolvedValueOnce(row() as never);
    await expect(
      updateBanner('banner-1', { startAt: new Date(ISO_END), endAt: new Date(ISO_START) }),
    ).rejects.toThrow('INVALID_PERIOD');
  });

  it('再有効化時の重複判定は自身を除外する', async () => {
    vi.mocked(prisma.systemBanner.findUnique).mockResolvedValueOnce(row({ enabled: false }) as never);
    vi.mocked(prisma.systemBanner.findFirst).mockResolvedValueOnce(null as never);
    vi.mocked(prisma.systemBanner.update).mockResolvedValueOnce(row({ enabled: true }) as never);
    await updateBanner('banner-1', { enabled: true });
    expect(prisma.systemBanner.findFirst).toHaveBeenCalledWith({
      where: {
        enabled: true,
        id: { not: 'banner-1' },
        startAt: { lt: new Date(ISO_END) },
        endAt: { gt: new Date(ISO_START) },
      },
      select: { id: true },
    });
    expect(prisma.systemBanner.update).toHaveBeenCalledOnce();
  });

  it('取り下げ (enabled=false) は重複チェックなしで更新する', async () => {
    vi.mocked(prisma.systemBanner.findUnique).mockResolvedValueOnce(row() as never);
    vi.mocked(prisma.systemBanner.update).mockResolvedValueOnce(row({ enabled: false }) as never);
    await setBannerEnabled('banner-1', false);
    expect(prisma.systemBanner.findFirst).not.toHaveBeenCalled();
    expect(prisma.systemBanner.update).toHaveBeenCalledOnce();
  });
});

describe('deleteBanner', () => {
  it('物理削除を呼ぶ', async () => {
    vi.mocked(prisma.systemBanner.delete).mockResolvedValueOnce(row() as never);
    await deleteBanner('banner-1');
    expect(prisma.systemBanner.delete).toHaveBeenCalledWith({ where: { id: 'banner-1' } });
  });
});
