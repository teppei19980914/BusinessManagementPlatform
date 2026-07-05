import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  prisma: {
    ideaAssetLink: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      deleteMany: vi.fn(),
    },
    task: { findFirst: vi.fn() },
    riskIssue: { findFirst: vi.fn() },
    knowledge: { findFirst: vi.fn() },
    retrospective: { findFirst: vi.fn() },
  },
}));

import {
  getIdeaAssetLinks,
  getIdeaAssetLinksByTarget,
  createIdeaAssetLink,
  deleteIdeaAssetLink,
  deleteIdeaAssetLinksForSource,
} from './idea-asset-link.service';
import { prisma } from '@/lib/db';

const T = '00000000-0000-0000-0000-000000000001';
const U = '00000000-0000-0000-0000-000000000003';
const SRC_ID = '00000000-0000-0000-0000-000000000010';
const TGT_ID = '00000000-0000-0000-0000-000000000020';
const LINK_ID = '00000000-0000-0000-0000-000000000030';

function makeLink(overrides: Record<string, unknown> = {}) {
  return {
    id: LINK_ID,
    tenantId: T,
    sourceType: 'voting_session',
    sourceId: SRC_ID,
    targetType: 'task',
    targetId: TGT_ID,
    createdBy: U,
    createdAt: new Date('2026-01-01'),
    ...overrides,
  };
}

const mp = prisma as unknown as {
  ideaAssetLink: Record<string, ReturnType<typeof vi.fn>>;
  task: Record<string, ReturnType<typeof vi.fn>>;
  riskIssue: Record<string, ReturnType<typeof vi.fn>>;
  knowledge: Record<string, ReturnType<typeof vi.fn>>;
  retrospective: Record<string, ReturnType<typeof vi.fn>>;
};

beforeEach(() => {
  vi.clearAllMocks();
});

// ============================================================
// getIdeaAssetLinks
// ============================================================
describe('getIdeaAssetLinks', () => {
  it('リンク一覧を返す (task のタイトルを取得)', async () => {
    mp.ideaAssetLink.findMany.mockResolvedValue([makeLink()]);
    mp.task.findFirst.mockResolvedValue({ name: 'タスク名' });

    const result = await getIdeaAssetLinks('voting_session', SRC_ID, T);
    expect(result).toHaveLength(1);
    expect(result[0].targetTitle).toBe('タスク名');
    expect(result[0].sourceType).toBe('voting_session');
  });

  it('空の場合は空配列を返す', async () => {
    mp.ideaAssetLink.findMany.mockResolvedValue([]);
    const result = await getIdeaAssetLinks('voting_session', SRC_ID, T);
    expect(result).toHaveLength(0);
  });
});

// ============================================================
// getIdeaAssetLinksByTarget
// ============================================================
describe('getIdeaAssetLinksByTarget', () => {
  it('target 側から逆引きする', async () => {
    mp.ideaAssetLink.findMany.mockResolvedValue([makeLink()]);
    mp.task.findFirst.mockResolvedValue({ name: 'タスク名' });

    const result = await getIdeaAssetLinksByTarget('task', TGT_ID, T);
    expect(result).toHaveLength(1);
    expect(result[0].targetTitle).toBe('タスク名');
  });
});

// ============================================================
// createIdeaAssetLink
// ============================================================
describe('createIdeaAssetLink', () => {
  it('リンクを作成して DTO を返す', async () => {
    mp.task.findFirst.mockResolvedValue({ name: 'タスク' });
    mp.ideaAssetLink.findFirst.mockResolvedValue(null);
    mp.ideaAssetLink.create.mockResolvedValue(makeLink());

    const result = await createIdeaAssetLink('voting_session', SRC_ID, 'task', TGT_ID, U, T);
    expect(result.targetTitle).toBe('タスク');
    expect(mp.ideaAssetLink.create).toHaveBeenCalledOnce();
  });

  it('対象が存在しない場合 TARGET_NOT_FOUND', async () => {
    mp.task.findFirst.mockResolvedValue(null);
    await expect(createIdeaAssetLink('voting_session', SRC_ID, 'task', TGT_ID, U, T)).rejects.toThrow(
      'TARGET_NOT_FOUND',
    );
  });

  it('重複リンクは ALREADY_LINKED', async () => {
    mp.task.findFirst.mockResolvedValue({ name: 'タスク' });
    mp.ideaAssetLink.findFirst.mockResolvedValue({ id: LINK_ID });
    await expect(createIdeaAssetLink('voting_session', SRC_ID, 'task', TGT_ID, U, T)).rejects.toThrow(
      'ALREADY_LINKED',
    );
  });

  it('knowledge target の場合 knowledge.findFirst を呼ぶ', async () => {
    mp.knowledge.findFirst.mockResolvedValue({ title: 'ナレッジ' });
    mp.ideaAssetLink.findFirst.mockResolvedValue(null);
    mp.ideaAssetLink.create.mockResolvedValue(makeLink({ targetType: 'knowledge', targetId: TGT_ID }));

    const result = await createIdeaAssetLink('qa_thread', SRC_ID, 'knowledge', TGT_ID, U, T);
    expect(mp.knowledge.findFirst).toHaveBeenCalledOnce();
    expect(result.targetTitle).toBe('ナレッジ');
  });
});

// ============================================================
// deleteIdeaAssetLink
// ============================================================
describe('deleteIdeaAssetLink', () => {
  it('作成者が削除できる', async () => {
    mp.ideaAssetLink.deleteMany.mockResolvedValue({ count: 1 });
    const result = await deleteIdeaAssetLink(LINK_ID, U, T);
    expect(result).toBe(true);
  });

  it('作成者以外または存在しない場合は false', async () => {
    mp.ideaAssetLink.deleteMany.mockResolvedValue({ count: 0 });
    const result = await deleteIdeaAssetLink(LINK_ID, 'other', T);
    expect(result).toBe(false);
  });
});

// ============================================================
// deleteIdeaAssetLinksForSource
// ============================================================
describe('deleteIdeaAssetLinksForSource', () => {
  it('ソースの全リンクを削除して件数を返す', async () => {
    mp.ideaAssetLink.deleteMany.mockResolvedValue({ count: 3 });
    const count = await deleteIdeaAssetLinksForSource('voting_session', SRC_ID, T);
    expect(count).toBe(3);
  });
});
