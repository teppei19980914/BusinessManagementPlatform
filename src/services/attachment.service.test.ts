import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => {
  const txAttachment = { updateMany: vi.fn() };
  const tx = { attachment: txAttachment };
  return {
    prisma: {
      attachment: {
        findMany: vi.fn(),
        findFirst: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn(),
      },
      project: { findFirst: vi.fn() },
      task: { findFirst: vi.fn() },
      estimate: { findFirst: vi.fn() },
      riskIssue: { findFirst: vi.fn() },
      retrospective: { findFirst: vi.fn() },
      knowledge: { findFirst: vi.fn() },
      memo: { findFirst: vi.fn() },
      $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(tx)),
      __tx: tx,
    },
  };
});

// ADR-0021: cascade delete で Supabase Storage を呼ぶ + storage-guard を atomic 減算
vi.mock('@/lib/supabase-storage', () => ({
  deleteObject: vi.fn(),
}));
vi.mock('@/services/storage-guard.service', () => ({
  assertFileStorageLimitInTx: vi.fn(),
}));
vi.mock('@/services/error-log.service', () => ({
  recordError: vi.fn(),
}));

import {
  listAttachments,
  getAttachment,
  createAttachment,
  updateAttachment,
  deleteAttachment,
  resolveProjectIds,
  authorizeMemoAttachment,
  getEntityVisibility,
} from './attachment.service';
import { prisma } from '@/lib/db';

const now = new Date('2026-04-21T10:00:00Z');
const row = (o: Record<string, unknown> = {}) => ({
  id: 'att-1',
  entityType: 'risk',
  entityId: 'r1',
  slot: 'general',
  displayName: 'ref',
  url: 'https://example.com/doc',
  mimeHint: undefined,
  addedBy: 'user-1',
  addedByUser: { name: 'Alice' },
  createdAt: now,
  updatedAt: now,
  ...o,
});

describe('listAttachments', () => {
  beforeEach(() => vi.clearAllMocks());

  it('entity 指定で取得する', async () => {
    vi.mocked(prisma.attachment.findMany).mockResolvedValue([row()] as never);

    const r = await listAttachments('risk', 'r1', 'tenant-A');

    expect(r).toHaveLength(1);
    expect(prisma.attachment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ entityType: 'risk', entityId: 'r1', deletedAt: null }),
      }),
    );
  });

  it('slot 指定ありの場合は where.slot にも反映', async () => {
    vi.mocked(prisma.attachment.findMany).mockResolvedValue([]);

    await listAttachments('risk', 'r1', 'tenant-A', 'primary');

    expect(prisma.attachment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ slot: 'primary' }),
      }),
    );
  });
});

describe('getAttachment', () => {
  beforeEach(() => vi.clearAllMocks());

  it('見つからなければ null', async () => {
    vi.mocked(prisma.attachment.findFirst).mockResolvedValue(null);
    expect(await getAttachment('x', 'tenant-A')).toBe(null);
  });

  it('見つかれば DTO', async () => {
    vi.mocked(prisma.attachment.findFirst).mockResolvedValue(row() as never);
    const r = await getAttachment('att-1', 'tenant-A');
    expect(r?.id).toBe('att-1');
    expect(r?.addedByName).toBe('Alice');
  });
});

describe('createAttachment', () => {
  beforeEach(() => vi.clearAllMocks());

  it('slot 未指定時は general を使う (updateMany は呼ばれない)', async () => {
    vi.mocked(prisma.attachment.create).mockResolvedValue(row() as never);

    await createAttachment(
      {
        entityType: 'risk',
        entityId: 'r1',
        displayName: 'n',
        url: 'https://a.b',
        mimeHint: undefined,
      } as never,
      'user-1',
      'tenant-A',
    );

    expect(prisma.attachment.updateMany).not.toHaveBeenCalled();
    expect(prisma.attachment.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ slot: 'general' }) }),
    );
  });

  it('primary slot 指定時は既存を論理削除してから create', async () => {
    vi.mocked(prisma.attachment.updateMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(prisma.attachment.create).mockResolvedValue(row({ slot: 'primary' }) as never);

    await createAttachment(
      {
        entityType: 'risk',
        entityId: 'r1',
        slot: 'primary',
        displayName: 'n',
        url: 'https://a.b',
        mimeHint: undefined,
      },
      'user-1',
      'tenant-A',
    );

    expect(prisma.attachment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ slot: 'primary', deletedAt: null }),
        data: { deletedAt: expect.any(Date) },
      }),
    );
    expect(prisma.attachment.create).toHaveBeenCalled();
  });
});

describe('updateAttachment / deleteAttachment', () => {
  beforeEach(() => vi.clearAllMocks());

  it('updateAttachment は指定フィールドのみ更新する', async () => {
    // 2026-05-09 feedback Phase 2-5: 冒頭の所有確認 mock 必須
    vi.mocked(prisma.attachment.findFirst).mockResolvedValue({ id: 'att-1' } as never);
    vi.mocked(prisma.attachment.update).mockResolvedValue(row({ displayName: 'new' }) as never);

    await updateAttachment('att-1', { displayName: 'new', url: 'https://x.y', mimeHint: undefined }, 'tenant-A');

    expect(prisma.attachment.update).toHaveBeenCalled();
  });

  it('deleteAttachment (URL 型) は論理削除のみ (Storage 呼出なし)', async () => {
    vi.mocked(prisma.attachment.findFirst).mockResolvedValueOnce({
      id: 'att-1',
      storageProvider: 'url',
      storageObjectKey: null,
      sizeBytes: null,
    } as never);
    const tx = (prisma as unknown as { __tx: { attachment: { updateMany: ReturnType<typeof vi.fn> } } })
      .__tx;
    tx.attachment.updateMany.mockResolvedValue({ count: 1 } as never);

    await deleteAttachment('att-1', 'tenant-A');

    expect(tx.attachment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'att-1', tenantId: 'tenant-A', deletedAt: null },
        data: { deletedAt: expect.any(Date) },
      }),
    );
  });

  it('deleteAttachment (Supabase 型) は Storage cascade + storage-guard 減算', async () => {
    const { deleteObject } = await import('@/lib/supabase-storage');
    const { assertFileStorageLimitInTx } = await import('@/services/storage-guard.service');
    vi.mocked(prisma.attachment.findFirst).mockResolvedValueOnce({
      id: 'att-1',
      storageProvider: 'supabase',
      storageObjectKey: 'tenants/T/project/E/uuid-spec.pdf',
      sizeBytes: BigInt(1_000_000),
    } as never);
    vi.mocked(deleteObject).mockResolvedValueOnce(undefined);

    await deleteAttachment('att-1', 'tenant-A');

    expect(deleteObject).toHaveBeenCalledWith('tenants/T/project/E/uuid-spec.pdf');
    expect(assertFileStorageLimitInTx).toHaveBeenCalledWith(
      expect.anything(),
      'tenant-A',
      -1_000_000,
    );
  });

  it('deleteAttachment (Supabase) Storage 削除失敗でも DB soft delete は実行', async () => {
    const { deleteObject } = await import('@/lib/supabase-storage');
    vi.mocked(prisma.attachment.findFirst).mockResolvedValueOnce({
      id: 'att-1',
      storageProvider: 'supabase',
      storageObjectKey: 'tenants/T/project/E/uuid-x.pdf',
      sizeBytes: BigInt(500_000),
    } as never);
    vi.mocked(deleteObject).mockRejectedValueOnce(new Error('storage 5xx'));

    await deleteAttachment('att-1', 'tenant-A');

    // DB の updateMany は呼ばれる (Storage 失敗を吸収して継続)
    const tx = (prisma as unknown as { __tx: { attachment: { updateMany: ReturnType<typeof vi.fn> } } })
      .__tx;
    expect(tx.attachment.updateMany).toHaveBeenCalled();
  });

  it('deleteAttachment 越境試行 (他テナント) → no-op', async () => {
    vi.mocked(prisma.attachment.findFirst).mockResolvedValueOnce(null);
    await deleteAttachment('att-1', 'tenant-X');
    const tx = (prisma as unknown as { __tx: { attachment: { updateMany: ReturnType<typeof vi.fn> } } })
      .__tx;
    expect(tx.attachment.updateMany).not.toHaveBeenCalled();
  });
});

describe('resolveProjectIds', () => {
  beforeEach(() => vi.clearAllMocks());

  it('project: 存在すれば [id]', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: 'p1' } as never);
    expect(await resolveProjectIds('project', 'p1', 'tenant-A')).toEqual(['p1']);
  });

  it('project: 不在なら null', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(null);
    expect(await resolveProjectIds('project', 'p1', 'tenant-A')).toBe(null);
  });

  it('task: projectId を返す', async () => {
    vi.mocked(prisma.task.findFirst).mockResolvedValue({ projectId: 'p2' } as never);
    expect(await resolveProjectIds('task', 't1', 'tenant-A')).toEqual(['p2']);
  });

  it('estimate: projectId を返す', async () => {
    vi.mocked(prisma.estimate.findFirst).mockResolvedValue({ projectId: 'p3' } as never);
    expect(await resolveProjectIds('estimate', 'e1', 'tenant-A')).toEqual(['p3']);
  });

  it('risk: 紐付け済プロジェクト全件を返す (M:N)', async () => {
    // PR feat/asset-multi-project-linking: M:N 化により紐付け済全プロジェクトを返す
    vi.mocked(prisma.riskIssue.findFirst).mockResolvedValue({
      id: 'r1',
      riskIssueProjects: [{ projectId: 'p4' }, { projectId: 'p4b' }],
    } as never);
    expect(await resolveProjectIds('risk', 'r1', 'tenant-A')).toEqual(['p4', 'p4b']);
  });

  it('retrospective: 紐付け済プロジェクト全件を返す (M:N)', async () => {
    vi.mocked(prisma.retrospective.findFirst).mockResolvedValue({
      id: 'ret1',
      retrospectiveProjects: [{ projectId: 'p5' }],
    } as never);
    expect(await resolveProjectIds('retrospective', 'r1', 'tenant-A')).toEqual(['p5']);
  });

  it('knowledge: 関連プロジェクト配列を返す', async () => {
    vi.mocked(prisma.knowledge.findFirst).mockResolvedValue({
      id: 'k1',
      knowledgeProjects: [{ projectId: 'pA' }, { projectId: 'pB' }],
    } as never);

    expect(await resolveProjectIds('knowledge', 'k1', 'tenant-A')).toEqual(['pA', 'pB']);
  });

  it('knowledge: 孤児 (紐付けゼロ) の場合は空配列', async () => {
    vi.mocked(prisma.knowledge.findFirst).mockResolvedValue({
      id: 'k1',
      knowledgeProjects: [],
    } as never);

    expect(await resolveProjectIds('knowledge', 'k1', 'tenant-A')).toEqual([]);
  });

  it('memo: 存在すれば [] (project スコープ外)', async () => {
    vi.mocked(prisma.memo.findFirst).mockResolvedValue({ id: 'm1' } as never);
    expect(await resolveProjectIds('memo', 'm1', 'tenant-A')).toEqual([]);
  });

  it('memo: 不在なら null', async () => {
    vi.mocked(prisma.memo.findFirst).mockResolvedValue(null);
    expect(await resolveProjectIds('memo', 'm1', 'tenant-A')).toBe(null);
  });
});

describe('authorizeMemoAttachment', () => {
  beforeEach(() => vi.clearAllMocks());

  it('memo 不在なら notFound: true', async () => {
    vi.mocked(prisma.memo.findFirst).mockResolvedValue(null);
    expect(await authorizeMemoAttachment('m1', 'u1', 'read', 'tenant-A')).toEqual({
      ok: false,
      notFound: true,
    });
  });

  it('write: 作成者本人のみ ok', async () => {
    vi.mocked(prisma.memo.findFirst).mockResolvedValue({
      userId: 'u1',
      visibility: 'public',
    } as never);
    expect(await authorizeMemoAttachment('m1', 'u1', 'write', 'tenant-A')).toEqual({
      ok: true,
      notFound: false,
    });
    expect(await authorizeMemoAttachment('m1', 'u2', 'write', 'tenant-A')).toEqual({
      ok: false,
      notFound: false,
    });
  });

  it('read: 作成者 OR public で ok', async () => {
    vi.mocked(prisma.memo.findFirst).mockResolvedValue({
      userId: 'u1',
      visibility: 'public',
    } as never);
    expect((await authorizeMemoAttachment('m1', 'u2', 'read', 'tenant-A')).ok).toBe(true);

    vi.mocked(prisma.memo.findFirst).mockResolvedValue({
      userId: 'u1',
      visibility: 'private',
    } as never);
    expect((await authorizeMemoAttachment('m1', 'u2', 'read', 'tenant-A')).ok).toBe(false);
    expect((await authorizeMemoAttachment('m1', 'u1', 'read', 'tenant-A')).ok).toBe(true);
  });
});

// PR #213 (2026-05-01): /api/attachments の visibility-aware 認可で使う helper のテスト
describe('getEntityVisibility', () => {
  beforeEach(() => vi.clearAllMocks());

  it('risk (public): visibility と reporterId を返す', async () => {
    vi.mocked(prisma.riskIssue.findFirst).mockResolvedValue({
      visibility: 'public',
      reporterId: 'u-1',
    } as never);
    expect(await getEntityVisibility('risk', 'r1', 'tenant-A')).toEqual({
      visibility: 'public',
      creatorId: 'u-1',
    });
  });

  it('risk (draft): visibility と reporterId を返す', async () => {
    vi.mocked(prisma.riskIssue.findFirst).mockResolvedValue({
      visibility: 'draft',
      reporterId: 'u-2',
    } as never);
    expect(await getEntityVisibility('risk', 'r1', 'tenant-A')).toEqual({
      visibility: 'draft',
      creatorId: 'u-2',
    });
  });

  it('retrospective: visibility と createdBy を返す', async () => {
    vi.mocked(prisma.retrospective.findFirst).mockResolvedValue({
      visibility: 'public',
      createdBy: 'u-3',
    } as never);
    expect(await getEntityVisibility('retrospective', 'retro-1', 'tenant-A')).toEqual({
      visibility: 'public',
      creatorId: 'u-3',
    });
  });

  it('knowledge: visibility と createdBy を返す', async () => {
    vi.mocked(prisma.knowledge.findFirst).mockResolvedValue({
      visibility: 'draft',
      createdBy: 'u-4',
    } as never);
    expect(await getEntityVisibility('knowledge', 'k1', 'tenant-A')).toEqual({
      visibility: 'draft',
      creatorId: 'u-4',
    });
  });

  it('risk が削除済なら not-found', async () => {
    vi.mocked(prisma.riskIssue.findFirst).mockResolvedValue(null);
    expect(await getEntityVisibility('risk', 'deleted', 'tenant-A')).toBe('not-found');
  });

  it('project / task / estimate / memo は null (visibility 概念なし)', async () => {
    expect(await getEntityVisibility('project', 'p1', 'tenant-A')).toBeNull();
    expect(await getEntityVisibility('task', 't1', 'tenant-A')).toBeNull();
    expect(await getEntityVisibility('estimate', 'e1', 'tenant-A')).toBeNull();
    expect(await getEntityVisibility('memo', 'm1', 'tenant-A')).toBeNull();
  });
});
