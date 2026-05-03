/**
 * seedTenant() の単体テスト (PR #6 / T-03 提案エンジン v2)
 *
 * 検証項目:
 *   - default-tenant のシードナレッジが新規テナントに正しく clone される
 *   - 既に同 title が存在する場合はスキップ (冪等性)
 *   - default-tenant 自身を引数にしたら明示的にエラー (誤操作防止)
 *   - clone 先テナントにユーザがいない場合はエラー (createdBy が必要)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// PrismaClient は実 DB に依存しないため mock する
const mockPrisma = {
  user: { findFirst: vi.fn() },
  knowledge: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
  },
  $executeRaw: vi.fn(),
};

// 各種モックは module 読込前にセットアップ
vi.mock('@prisma/adapter-pg', () => ({ PrismaPg: vi.fn() }));
vi.mock('pg', () => ({ Pool: vi.fn() }));
vi.mock('../src/generated/prisma/client', () => ({
  PrismaClient: vi.fn().mockImplementation(() => mockPrisma),
}));

import { seedTenant } from './seed-suggestion';
import { DEFAULT_TENANT_ID } from '../src/lib/tenant';

const TENANT_A = '11111111-1111-1111-1111-111111111111';

describe('seedTenant', () => {
  beforeEach(() => vi.clearAllMocks());

  it('default-tenant を対象にしたらエラー (誤操作防止)', async () => {
    await expect(seedTenant(mockPrisma as never, DEFAULT_TENANT_ID)).rejects.toThrow(
      'default-tenant 以外を対象とする',
    );
  });

  it('clone 先テナントにユーザがいなければエラー', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(null);
    await expect(seedTenant(mockPrisma as never, TENANT_A)).rejects.toThrow(
      'ユーザが存在しません',
    );
  });

  it('default-tenant の knowledge を tenant_a に clone する', async () => {
    mockPrisma.user.findFirst.mockResolvedValue({ id: 'admin-user-a' });
    mockPrisma.knowledge.findMany.mockResolvedValue([
      {
        id: 'src-1',
        title: 'Brooks の法則 — 遅延プロジェクトへの人員追加は、さらなる遅延を招く',
        knowledgeType: 'lesson_learned',
        background: 'bg',
        content: 'c',
        result: 'r',
        conclusion: 'concl',
        recommendation: 'rec',
        reusability: 'reuse',
        techTags: [],
        devMethod: null,
        processTags: ['project_management'],
        businessDomainTags: [],
      },
    ]);
    // 冪等性チェックは「既存なし」を返す
    mockPrisma.knowledge.findFirst.mockResolvedValue(null);
    mockPrisma.knowledge.create.mockResolvedValue({ id: 'cloned-1' });
    mockPrisma.$executeRaw.mockResolvedValue(1);

    const result = await seedTenant(mockPrisma as never, TENANT_A);

    expect(result.inserted).toBe(1);
    expect(result.skipped).toBe(0);

    // create は tenantId 切替で呼ばれている
    expect(mockPrisma.knowledge.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: TENANT_A,
          title: 'Brooks の法則 — 遅延プロジェクトへの人員追加は、さらなる遅延を招く',
          createdBy: 'admin-user-a',
          visibility: 'public',
        }),
      }),
    );

    // embedding コピーの raw SQL が呼ばれている
    expect(mockPrisma.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it('既に同 title が tenant_a にあればスキップ (冪等性)', async () => {
    mockPrisma.user.findFirst.mockResolvedValue({ id: 'admin-user-a' });
    mockPrisma.knowledge.findMany.mockResolvedValue([
      { id: 'src-1', title: 'Brooks の法則 — 遅延プロジェクトへの人員追加は、さらなる遅延を招く', knowledgeType: 'lesson_learned', background: 'bg', content: 'c', result: 'r', conclusion: null, recommendation: null, reusability: null, techTags: [], devMethod: null, processTags: [], businessDomainTags: [] },
    ]);
    // 冪等性チェックは「既存あり」を返す
    mockPrisma.knowledge.findFirst.mockResolvedValue({ id: 'existing-id' });

    const result = await seedTenant(mockPrisma as never, TENANT_A);

    expect(result.inserted).toBe(0);
    expect(result.skipped).toBe(1);
    expect(mockPrisma.knowledge.create).not.toHaveBeenCalled();
    expect(mockPrisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('default-tenant 側にシードがゼロ (= まだ default-tenant に投入していない場合) は inserted=0', async () => {
    mockPrisma.user.findFirst.mockResolvedValue({ id: 'admin-user-a' });
    mockPrisma.knowledge.findMany.mockResolvedValue([]); // source が空

    const result = await seedTenant(mockPrisma as never, TENANT_A);

    expect(result.inserted).toBe(0);
    expect(result.skipped).toBe(0);
    expect(mockPrisma.knowledge.create).not.toHaveBeenCalled();
  });
});
