import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
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
  },
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
  mimeHint: null,
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

    const r = await listAttachments('risk', 'r1');

    expect(r).toHaveLength(1);
    expect(prisma.attachment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ entityType: 'risk', entityId: 'r1', deletedAt: null }),
      }),
    );
  });

  it('slot 指定ありの場合は where.slot にも反映', async () => {
    vi.mocked(prisma.attachment.findMany).mockResolvedValue([]);

    await listAttachments('risk', 'r1', 'primary');

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
    expect(await getAttachment('x')).toBe(null);
  });

  it('見つかれば DTO', async () => {
    vi.mocked(prisma.attachment.findFirst).mockResolvedValue(row() as never);
    const r = await getAttachment('att-1');
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
        mimeHint: null,
      },
      'user-1',
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
        mimeHint: null,
      },
      'user-1',
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
    vi.mocked(prisma.attachment.update).mockResolvedValue(row({ displayName: 'new' }) as never);

    await updateAttachment('att-1', { displayName: 'new', url: 'https://x.y', mimeHint: null });

    expect(prisma.attachment.update).toHaveBeenCalled();
  });

  it('deleteAttachment は論理削除 (deletedAt set)', async () => {
    vi.mocked(prisma.attachment.update).mockResolvedValue({} as never);

    await deleteAttachment('att-1');

    expect(prisma.attachment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'att-1' },
        data: { deletedAt: expect.any(Date) },
      }),
    );
  });
});

describe('resolveProjectIds', () => {
  beforeEach(() => vi.clearAllMocks());

  it('project: 存在すれば [id]', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: 'p1' } as never);
    expect(await resolveProjectIds('project', 'p1')).toEqual(['p1']);
  });

  it('project: 不在なら null', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(null);
    expect(await resolveProjectIds('project', 'p1')).toBe(null);
  });

  it('task: projectId を返す', async () => {
    vi.mocked(prisma.task.findFirst).mockResolvedValue({ projectId: 'p2' } as never);
    expect(await resolveProjectIds('task', 't1')).toEqual(['p2']);
  });

  it('estimate: projectId を返す', async () => {
    vi.mocked(prisma.estimate.findFirst).mockResolvedValue({ projectId: 'p3' } as never);
    expect(await resolveProjectIds('estimate', 'e1')).toEqual(['p3']);
  });

  it('risk: projectId を返す', async () => {
    vi.mocked(prisma.riskIssue.findFirst).mockResolvedValue({ projectId: 'p4' } as never);
    expect(await resolveProjectIds('risk', 'r1')).toEqual(['p4']);
  });

  it('retrospective: projectId を返す', async () => {
    vi.mocked(prisma.retrospective.findFirst).mockResolvedValue({ projectId: 'p5' } as never);
    expect(await resolveProjectIds('retrospective', 'r1')).toEqual(['p5']);
  });

  it('knowledge: 関連プロジェクト配列を返す', async () => {
    vi.mocked(prisma.knowledge.findFirst).mockResolvedValue({
      id: 'k1',
      knowledgeProjects: [{ projectId: 'pA' }, { projectId: 'pB' }],
    } as never);

    expect(await resolveProjectIds('knowledge', 'k1')).toEqual(['pA', 'pB']);
  });

  it('knowledge: 孤児 (紐付けゼロ) の場合は空配列', async () => {
    vi.mocked(prisma.knowledge.findFirst).mockResolvedValue({
      id: 'k1',
      knowledgeProjects: [],
    } as never);

    expect(await resolveProjectIds('knowledge', 'k1')).toEqual([]);
  });

  it('memo: 存在すれば [] (project スコープ外)', async () => {
    vi.mocked(prisma.memo.findFirst).mockResolvedValue({ id: 'm1' } as never);
    expect(await resolveProjectIds('memo', 'm1')).toEqual([]);
  });

  it('memo: 不在なら null', async () => {
    vi.mocked(prisma.memo.findFirst).mockResolvedValue(null);
    expect(await resolveProjectIds('memo', 'm1')).toBe(null);
  });
});

describe('authorizeMemoAttachment', () => {
  beforeEach(() => vi.clearAllMocks());

  it('memo 不在なら notFound: true', async () => {
    vi.mocked(prisma.memo.findFirst).mockResolvedValue(null);
    expect(await authorizeMemoAttachment('m1', 'u1', 'read')).toEqual({
      ok: false,
      notFound: true,
    });
  });

  it('write: 作成者本人のみ ok', async () => {
    vi.mocked(prisma.memo.findFirst).mockResolvedValue({
      userId: 'u1',
      visibility: 'public',
    } as never);
    expect(await authorizeMemoAttachment('m1', 'u1', 'write')).toEqual({
      ok: true,
      notFound: false,
    });
    expect(await authorizeMemoAttachment('m1', 'u2', 'write')).toEqual({
      ok: false,
      notFound: false,
    });
  });

  it('read: 作成者 OR public で ok', async () => {
    vi.mocked(prisma.memo.findFirst).mockResolvedValue({
      userId: 'u1',
      visibility: 'public',
    } as never);
    expect((await authorizeMemoAttachment('m1', 'u2', 'read')).ok).toBe(true);

    vi.mocked(prisma.memo.findFirst).mockResolvedValue({
      userId: 'u1',
      visibility: 'private',
    } as never);
    expect((await authorizeMemoAttachment('m1', 'u2', 'read')).ok).toBe(false);
    expect((await authorizeMemoAttachment('m1', 'u1', 'read')).ok).toBe(true);
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
    expect(await getEntityVisibility('risk', 'r1')).toEqual({
      visibility: 'public',
      creatorId: 'u-1',
    });
  });

  it('risk (draft): visibility と reporterId を返す', async () => {
    vi.mocked(prisma.riskIssue.findFirst).mockResolvedValue({
      visibility: 'draft',
      reporterId: 'u-2',
    } as never);
    expect(await getEntityVisibility('risk', 'r1')).toEqual({
      visibility: 'draft',
      creatorId: 'u-2',
    });
  });

  it('retrospective: visibility と createdBy を返す', async () => {
    vi.mocked(prisma.retrospective.findFirst).mockResolvedValue({
      visibility: 'public',
      createdBy: 'u-3',
    } as never);
    expect(await getEntityVisibility('retrospective', 'retro-1')).toEqual({
      visibility: 'public',
      creatorId: 'u-3',
    });
  });

  it('knowledge: visibility と createdBy を返す', async () => {
    vi.mocked(prisma.knowledge.findFirst).mockResolvedValue({
      visibility: 'draft',
      createdBy: 'u-4',
    } as never);
    expect(await getEntityVisibility('knowledge', 'k1')).toEqual({
      visibility: 'draft',
      creatorId: 'u-4',
    });
  });

  it('risk が削除済なら not-found', async () => {
    vi.mocked(prisma.riskIssue.findFirst).mockResolvedValue(null);
    expect(await getEntityVisibility('risk', 'deleted')).toBe('not-found');
  });

  it('project / task / estimate / memo は null (visibility 概念なし)', async () => {
    expect(await getEntityVisibility('project', 'p1')).toBeNull();
    expect(await getEntityVisibility('task', 't1')).toBeNull();
    expect(await getEntityVisibility('estimate', 'e1')).toBeNull();
    expect(await getEntityVisibility('memo', 'm1')).toBeNull();
  });
});
