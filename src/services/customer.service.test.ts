import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  prisma: {
    customer: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  },
}));

import {
  listCustomers,
  getCustomer,
  createCustomer,
  updateCustomer,
  deleteCustomer,
} from './customer.service';
import { prisma } from '@/lib/db';

const now = new Date('2026-04-23T10:00:00Z');

const customerRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'c-1',
  name: '株式会社サンプル',
  department: '情報システム部',
  contactPerson: '山田太郎',
  contactEmail: 'yamada@example.com',
  notes: null,
  createdBy: 'u-admin',
  updatedBy: 'u-admin',
  createdAt: now,
  updatedAt: now,
  _count: { projects: 0 },
  ...overrides,
});

describe('listCustomers', () => {
  beforeEach(() => vi.clearAllMocks());

  it('顧客一覧を name 昇順で取得し DTO に変換する', async () => {
    vi.mocked(prisma.customer.findMany).mockResolvedValue([
      customerRow({ id: 'a', name: 'A 社' }),
      customerRow({ id: 'b', name: 'B 社', _count: { projects: 3 } }),
    ] as never);

    const result = await listCustomers();

    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('A 社');
    expect(result[0].activeProjectCount).toBe(0);
    expect(result[1].activeProjectCount).toBe(3);
    expect(prisma.customer.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: { name: 'asc' },
      }),
    );
  });
});

describe('getCustomer', () => {
  beforeEach(() => vi.clearAllMocks());

  it('存在する顧客を DTO で返す', async () => {
    vi.mocked(prisma.customer.findUnique).mockResolvedValue(customerRow() as never);
    const result = await getCustomer('c-1');
    expect(result?.id).toBe('c-1');
    expect(result?.activeProjectCount).toBe(0);
  });

  it('存在しない顧客は null を返す', async () => {
    vi.mocked(prisma.customer.findUnique).mockResolvedValue(null);
    const result = await getCustomer('nope');
    expect(result).toBeNull();
  });
});

describe('createCustomer', () => {
  beforeEach(() => vi.clearAllMocks());

  it('入力値を DB に保存し createdBy/updatedBy をセットする', async () => {
    vi.mocked(prisma.customer.create).mockResolvedValue(
      customerRow({ name: '新規会社' }) as never,
    );

    const result = await createCustomer(
      {
        name: '新規会社',
        department: '開発部',
        contactPerson: null,
        contactEmail: null,
        notes: null,
      },
      'u-admin',
    );

    expect(result.name).toBe('新規会社');
    expect(prisma.customer.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          name: '新規会社',
          department: '開発部',
          contactPerson: null,
          contactEmail: null,
          notes: null,
          createdBy: 'u-admin',
          updatedBy: 'u-admin',
        }),
      }),
    );
  });

  it('空文字列は null に正規化する (optional フィールド)', async () => {
    vi.mocked(prisma.customer.create).mockResolvedValue(customerRow() as never);
    await createCustomer(
      { name: 'C', department: '', contactPerson: '', contactEmail: '', notes: '' },
      'u-admin',
    );
    expect(prisma.customer.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          department: null,
          contactPerson: null,
          contactEmail: null,
          notes: null,
        }),
      }),
    );
  });
});

describe('updateCustomer', () => {
  beforeEach(() => vi.clearAllMocks());

  it('存在する顧客を更新し updatedBy をセットする', async () => {
    vi.mocked(prisma.customer.findUnique).mockResolvedValue({ id: 'c-1' } as never);
    vi.mocked(prisma.customer.update).mockResolvedValue(
      customerRow({ name: '改名後' }) as never,
    );

    const result = await updateCustomer(
      'c-1',
      { name: '改名後', notes: '更新しました' },
      'u-admin',
    );

    expect(result?.name).toBe('改名後');
    expect(prisma.customer.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'c-1' },
        data: expect.objectContaining({
          name: '改名後',
          notes: '更新しました',
          updatedBy: 'u-admin',
        }),
      }),
    );
  });

  it('存在しない顧客の更新は null を返す', async () => {
    vi.mocked(prisma.customer.findUnique).mockResolvedValue(null);
    const result = await updateCustomer('nope', { name: 'x' }, 'u-admin');
    expect(result).toBeNull();
    expect(prisma.customer.update).not.toHaveBeenCalled();
  });

  it('空文字列の optional フィールドは null に正規化する', async () => {
    vi.mocked(prisma.customer.findUnique).mockResolvedValue({ id: 'c-1' } as never);
    vi.mocked(prisma.customer.update).mockResolvedValue(customerRow() as never);
    await updateCustomer(
      'c-1',
      { department: '', contactEmail: '', notes: '' },
      'u-admin',
    );
    expect(prisma.customer.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          department: null,
          contactEmail: null,
          notes: null,
        }),
      }),
    );
  });

  it('undefined フィールドは更新対象から外す (部分更新)', async () => {
    vi.mocked(prisma.customer.findUnique).mockResolvedValue({ id: 'c-1' } as never);
    vi.mocked(prisma.customer.update).mockResolvedValue(customerRow() as never);

    await updateCustomer('c-1', { name: 'new-name' }, 'u-admin');

    const callArg = vi.mocked(prisma.customer.update).mock.calls[0][0];
    const data = callArg.data as Record<string, unknown>;
    expect(data.name).toBe('new-name');
    // 明示的に undefined を渡したフィールドは data に含まれない想定
    expect(data.department).toBeUndefined();
    expect(data.notes).toBeUndefined();
  });
});

describe('deleteCustomer', () => {
  beforeEach(() => vi.clearAllMocks());

  it('active Project が無い顧客は物理削除できる', async () => {
    vi.mocked(prisma.customer.findUnique).mockResolvedValue(
      customerRow({ _count: { projects: 0 } }) as never,
    );
    vi.mocked(prisma.customer.delete).mockResolvedValue(customerRow() as never);

    const result = await deleteCustomer('c-1');

    expect(result).toEqual({ ok: true });
    expect(prisma.customer.delete).toHaveBeenCalledWith({ where: { id: 'c-1' } });
  });

  it('active Project が 1 件でも紐付いていれば削除不可 (has_active_projects)', async () => {
    vi.mocked(prisma.customer.findUnique).mockResolvedValue(
      customerRow({ _count: { projects: 2 } }) as never,
    );

    const result = await deleteCustomer('c-1');

    expect(result).toEqual({
      ok: false,
      reason: 'has_active_projects',
      activeProjectCount: 2,
    });
    expect(prisma.customer.delete).not.toHaveBeenCalled();
  });

  it('存在しない顧客は not_found を返す', async () => {
    vi.mocked(prisma.customer.findUnique).mockResolvedValue(null);
    const result = await deleteCustomer('nope');
    expect(result).toEqual({ ok: false, reason: 'not_found' });
    expect(prisma.customer.delete).not.toHaveBeenCalled();
  });
});
