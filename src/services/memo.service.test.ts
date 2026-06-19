import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  prisma: {
    memo: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      // PR #162 / PR #165: bulkUpdateMemosVisibilityFromList が呼ぶ
      updateMany: vi.fn(),
    },
    // PR #89: deleteMemo が attachment.updateMany を $transaction 内で呼ぶ
    attachment: { updateMany: vi.fn() },
    // v1.3.0 資産導線機能: deleteMemo が deleteAssetLinksForEntity 経由で呼ぶ (count 読み取りのため既定値必須)
    assetLink: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    $transaction: vi.fn((ops: unknown[]) => Promise.all(ops)),
  },
}));

// (2026-05-15) Memo に embedding 生成が追加されたためモック注入。
//   visibility='public' のときのみ呼ばれることをテストで検証する。
// 2026-05-24 (UI_PATTERNS §35 embedding 追補): bulkUpdateMemosVisibilityFromList が batch helper を呼ぶ
vi.mock('./embedding.service', () => ({
  generateAndPersistEntityEmbedding: vi.fn().mockResolvedValue(undefined),
  generateAndPersistBatchEmbeddings: vi.fn().mockResolvedValue({ generated: 0, failed: 0, costJpy: 0 }),
}));

// feat/asset-assignee-expansion (2026-05-26): クロステナント assigneeId 検証 mock
vi.mock('@/lib/assignee-validation', () => ({
  assertAssigneeTenant: vi.fn().mockResolvedValue(undefined),
}));

import {
  listMyMemos,
  listPublicMemos,
  getMemoForViewer,
  createMemo,
  updateMemo,
  deleteMemo,
  bulkUpdateMemosVisibilityFromList,
} from './memo.service';
import { prisma } from '@/lib/db';
import { getMockCallArg } from '@/lib/test-mock-helpers';
import { generateAndPersistEntityEmbedding, generateAndPersistBatchEmbeddings } from './embedding.service';

const now = new Date('2026-04-21T10:00:00Z');

const memoRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'memo-1',
  userId: 'user-1',
  title: 'T',
  content: 'C',
  visibility: 'private',
  // feat/asset-assignee-expansion (2026-05-26)
  assigneeId: null,
  assignee: null,
  createdAt: now,
  updatedAt: now,
  author: { name: 'Alice' },
  ...overrides,
});

describe('listMyMemos', () => {
  beforeEach(() => vi.clearAllMocks());

  it('自分のメモを新しい順で取得し DTO に変換する', async () => {
    vi.mocked(prisma.memo.findMany).mockResolvedValue([
      memoRow({ id: 'a' }),
      memoRow({ id: 'b', visibility: 'public' }),
    ] as never);

    const result = await listMyMemos('user-1', 'tenant-A');

    expect(result).toHaveLength(2);
    expect(result[0].isMine).toBe(true);
    expect(result[0].authorName).toBe('Alice');
    expect(prisma.memo.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { deletedAt: null, userId: 'user-1', tenantId: 'tenant-A' },
        orderBy: { createdAt: 'desc' },
      }),
    );
  });

  it('viewerTenantId 以外のメモは含めない (テナント越境防止)', async () => {
    vi.mocked(prisma.memo.findMany).mockResolvedValue([]);
    await listMyMemos('user-1', 'tenant-A');
    const call = getMockCallArg(vi.mocked(prisma.memo.findMany));
    expect((call.where as unknown as { tenantId: string }).tenantId).toBe('tenant-A');
  });
});

describe('listPublicMemos', () => {
  beforeEach(() => vi.clearAllMocks());

  it('public メモを全件取得し、自分のメモだけ isMine: true になる', async () => {
    vi.mocked(prisma.memo.findMany).mockResolvedValue([
      memoRow({ id: 'a', userId: 'user-1', visibility: 'public' }),
      memoRow({ id: 'b', userId: 'user-2', visibility: 'public' }),
    ] as never);

    const result = await listPublicMemos('user-1', 'tenant-A');

    expect(result[0].isMine).toBe(true);
    expect(result[1].isMine).toBe(false);
    expect(prisma.memo.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { deletedAt: null, visibility: 'public', tenantId: 'tenant-A' },
      }),
    );
  });

  it('viewerTenantId 以外の public メモは含めない (テナント越境防止)', async () => {
    vi.mocked(prisma.memo.findMany).mockResolvedValue([]);
    await listPublicMemos('user-1', 'tenant-A');
    const call = getMockCallArg(vi.mocked(prisma.memo.findMany));
    expect((call.where as unknown as { tenantId: string }).tenantId).toBe('tenant-A');
  });
});

describe('getMemoForViewer', () => {
  beforeEach(() => vi.clearAllMocks());

  it('存在しなければ null', async () => {
    vi.mocked(prisma.memo.findFirst).mockResolvedValue(null);
    expect(await getMemoForViewer('x', 'user-1', 'tenant-A')).toBe(null);
  });

  it('本人なら private でも取得可', async () => {
    vi.mocked(prisma.memo.findFirst).mockResolvedValue(
      memoRow({ userId: 'user-1', visibility: 'private' }) as never,
    );
    const result = await getMemoForViewer('memo-1', 'user-1', 'tenant-A');
    expect(result?.isMine).toBe(true);
  });

  it('他人の private は null (漏洩防止)', async () => {
    vi.mocked(prisma.memo.findFirst).mockResolvedValue(
      memoRow({ userId: 'user-2', visibility: 'private' }) as never,
    );
    expect(await getMemoForViewer('memo-1', 'user-1', 'tenant-A')).toBe(null);
  });

  it('他人の public は取得可 (isMine: false)', async () => {
    vi.mocked(prisma.memo.findFirst).mockResolvedValue(
      memoRow({ userId: 'user-2', visibility: 'public' }) as never,
    );
    const result = await getMemoForViewer('memo-1', 'user-1', 'tenant-A');
    expect(result?.isMine).toBe(false);
  });
});

describe('createMemo', () => {
  beforeEach(() => vi.clearAllMocks());

  it('visibility 未指定時は private', async () => {
    vi.mocked(prisma.memo.create).mockResolvedValue(
      memoRow({ visibility: 'private' }) as never,
    );
    await createMemo({ title: 't', content: 'c', visibility: 'private' }, 'user-1', 'tenant-A');
    expect(prisma.memo.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ visibility: 'private' }) }),
    );
  });

  it('public 指定でそのまま保存', async () => {
    vi.mocked(prisma.memo.create).mockResolvedValue(
      memoRow({ visibility: 'public' }) as never,
    );
    await createMemo({ title: 't', content: 'c', visibility: 'public' }, 'user-1', 'tenant-A');
    expect(prisma.memo.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ visibility: 'public' }) }),
    );
  });

  // feat/asset-assignee-expansion (2026-05-26) severity-1: private memo に他人 assignee を拒否
  it('private memo + 他人 assignee 指定 (create) → PRIVATE_MEMO_ASSIGNEE_FORBIDDEN', async () => {
    await expect(
      createMemo({ title: 't', content: 'c', visibility: 'private', assigneeId: 'user-other' }, 'user-1', 'tenant-A'),
    ).rejects.toThrow('PRIVATE_MEMO_ASSIGNEE_FORBIDDEN');
    expect(prisma.memo.create).not.toHaveBeenCalled();
  });

  it('public + 他人 assignee 指定 (create) は許容', async () => {
    vi.mocked(prisma.memo.create).mockResolvedValue(
      memoRow({ visibility: 'public', assigneeId: 'user-other' }) as never,
    );
    await createMemo({ title: 't', content: 'c', visibility: 'public', assigneeId: 'user-other' }, 'user-1', 'tenant-A');
    expect(prisma.memo.create).toHaveBeenCalled();
  });
});

describe('updateMemo', () => {
  beforeEach(() => vi.clearAllMocks());

  it('存在しなければ null', async () => {
    vi.mocked(prisma.memo.findFirst).mockResolvedValue(null);
    expect(await updateMemo('x', { title: 't2' }, 'user-1', 'tenant-A')).toBe(null);
    expect(prisma.memo.update).not.toHaveBeenCalled();
  });

  it('他人のメモは更新不可 (null)', async () => {
    vi.mocked(prisma.memo.findFirst).mockResolvedValue(
      { userId: 'user-2', assigneeId: null } as never,
    );
    expect(await updateMemo('memo-1', { title: 't2' }, 'user-1', 'tenant-A')).toBe(null);
    expect(prisma.memo.update).not.toHaveBeenCalled();
  });

  it('作成者本人なら更新できる', async () => {
    vi.mocked(prisma.memo.findFirst).mockResolvedValue({ userId: 'user-1' } as never);
    vi.mocked(prisma.memo.update).mockResolvedValue(
      memoRow({ title: 't2' }) as never,
    );

    const result = await updateMemo('memo-1', { title: 't2' }, 'user-1', 'tenant-A');

    expect(result?.title).toBe('t2');
    expect(prisma.memo.update).toHaveBeenCalled();
  });

  // feat/asset-assignee-expansion (2026-05-26): 担当者も update 可能
  it('担当者 (assigneeId === userId) は更新可能', async () => {
    vi.mocked(prisma.memo.findFirst).mockResolvedValue(
      { userId: 'user-creator', assigneeId: 'user-assignee', visibility: 'public' } as never,
    );
    vi.mocked(prisma.memo.update).mockResolvedValue(memoRow({ title: 't2' }) as never);

    const result = await updateMemo('memo-1', { title: 't2' }, 'user-assignee', 'tenant-A');

    expect(result?.title).toBe('t2');
    expect(prisma.memo.update).toHaveBeenCalled();
  });

  // feat/asset-assignee-expansion (2026-05-26) severity-1: private memo に他人 assignee を拒否
  it('private memo に他人 assignee 指定 → PRIVATE_MEMO_ASSIGNEE_FORBIDDEN', async () => {
    vi.mocked(prisma.memo.findFirst).mockResolvedValue(
      { userId: 'user-1', assigneeId: null, visibility: 'private', title: 't', content: 'c' } as never,
    );
    await expect(
      updateMemo('memo-1', { assigneeId: 'user-other' }, 'user-1', 'tenant-A'),
    ).rejects.toThrow('PRIVATE_MEMO_ASSIGNEE_FORBIDDEN');
    expect(prisma.memo.update).not.toHaveBeenCalled();
  });

  it('public → private 変更時に既存 assignee=他人 が残ると拒否', async () => {
    vi.mocked(prisma.memo.findFirst).mockResolvedValue(
      { userId: 'user-1', assigneeId: 'user-other', visibility: 'public', title: 't', content: 'c' } as never,
    );
    await expect(
      updateMemo('memo-1', { visibility: 'private' }, 'user-1', 'tenant-A'),
    ).rejects.toThrow('PRIVATE_MEMO_ASSIGNEE_FORBIDDEN');
  });

  it('private memo でも assignee=本人 (self-assign) は許容', async () => {
    vi.mocked(prisma.memo.findFirst).mockResolvedValue(
      { userId: 'user-1', assigneeId: null, visibility: 'private', title: 't', content: 'c' } as never,
    );
    vi.mocked(prisma.memo.update).mockResolvedValue(memoRow({ assigneeId: 'user-1' }) as never);
    const result = await updateMemo('memo-1', { assigneeId: 'user-1' }, 'user-1', 'tenant-A');
    expect(result).not.toBeNull();
  });
});

describe('deleteMemo', () => {
  beforeEach(() => vi.clearAllMocks());

  it('存在しなければ false', async () => {
    vi.mocked(prisma.memo.findFirst).mockResolvedValue(null);
    expect(await deleteMemo('x', 'user-1', 'tenant-A', 'general')).toBe(false);
  });

  it('他人のメモは false (一般ユーザ)', async () => {
    vi.mocked(prisma.memo.findFirst).mockResolvedValue(
      { userId: 'user-2', assigneeId: null, visibility: 'private' } as never,
    );
    expect(await deleteMemo('memo-1', 'user-1', 'tenant-A', 'general')).toBe(false);
    expect(prisma.memo.update).not.toHaveBeenCalled();
  });

  // feat/asset-assignee-expansion (2026-05-26): 担当者も削除可能
  it('担当者 (assigneeId === userId) は削除可能', async () => {
    vi.mocked(prisma.memo.findFirst).mockResolvedValue(
      { userId: 'user-creator', assigneeId: 'user-assignee', visibility: 'public' } as never,
    );
    vi.mocked(prisma.memo.update).mockResolvedValue({} as never);
    vi.mocked(prisma.attachment.updateMany).mockResolvedValue({ count: 0 } as never);

    expect(await deleteMemo('memo-1', 'user-assignee', 'tenant-A', 'general')).toBe(true);
    expect(prisma.memo.update).toHaveBeenCalled();
  });

  // feat/crud-permission-redesign (2026-05-20): admin の public モデレーション削除
  it('admin は他人の public メモを削除可', async () => {
    vi.mocked(prisma.memo.findFirst).mockResolvedValue(
      { userId: 'user-2', visibility: 'public' } as never,
    );
    vi.mocked(prisma.memo.update).mockResolvedValue({} as never);
    expect(await deleteMemo('memo-1', 'admin-x', 'tenant-A', 'admin')).toBe(true);
    expect(prisma.memo.update).toHaveBeenCalled();
  });

  it('admin であっても他人の private メモは削除不可 (プライバシー保護)', async () => {
    vi.mocked(prisma.memo.findFirst).mockResolvedValue(
      { userId: 'user-2', visibility: 'private' } as never,
    );
    expect(await deleteMemo('memo-1', 'admin-x', 'tenant-A', 'admin')).toBe(false);
    expect(prisma.memo.update).not.toHaveBeenCalled();
  });

  it('本人なら自分の private メモも削除可', async () => {
    vi.mocked(prisma.memo.findFirst).mockResolvedValue(
      { userId: 'user-1', visibility: 'private' } as never,
    );
    vi.mocked(prisma.memo.update).mockResolvedValue({} as never);
    expect(await deleteMemo('memo-1', 'user-1', 'tenant-A', 'general')).toBe(true);
  });

  it('本人なら論理削除して true', async () => {
    vi.mocked(prisma.memo.findFirst).mockResolvedValue(
      { userId: 'user-1', visibility: 'public' } as never,
    );
    vi.mocked(prisma.memo.update).mockResolvedValue({} as never);

    expect(await deleteMemo('memo-1', 'user-1', 'tenant-A', 'general')).toBe(true);
    expect(prisma.memo.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'memo-1' },
        data: { deletedAt: expect.any(Date) },
      }),
    );
  });
});

// PR #162 → PR #165 で個人「メモ一覧」(/memos) に移し替え。Memo は personal scope (project に紐付かない)。
// path は維持 (/api/memos/bulk) なので route.test.ts の修正は最小限。
describe('bulkUpdateMemosVisibilityFromList', () => {
  beforeEach(() => vi.clearAllMocks());

  it('ids 空 → updateMany 呼ばず 0 件', async () => {
    const r = await bulkUpdateMemosVisibilityFromList([], 'private', 'u-1', 't-1');
    expect(r).toEqual({ updatedIds: [], skippedNotOwned: 0, skippedNotFound: 0, skippedEmptyTitle: 0, embeddingsGenerated: 0 });
    expect(prisma.memo.updateMany).not.toHaveBeenCalled();
  });

  it('userId 本人のみ updateMany される (他人混入は silent skip)', async () => {
    vi.mocked(prisma.memo.findMany).mockResolvedValue([
      { id: 'memo-1', userId: 'u-1', title: '正しいタイトル' },
      { id: 'memo-2', userId: 'u-OTHER', title: '他人のメモ' },
    ] as never);
    vi.mocked(prisma.memo.updateMany).mockResolvedValue({ count: 1 } as never);

    const r = await bulkUpdateMemosVisibilityFromList(['memo-1', 'memo-2'], 'private', 'u-1', 't-1');

    expect(r.updatedIds).toEqual(['memo-1']);
    expect(r.skippedNotOwned).toBe(1);

    const call = getMockCallArg(vi.mocked(prisma.memo.updateMany));
    expect(call.data).toEqual({ visibility: 'private' });
    // Memo は updatedBy 列を持たない (作成者本人のみ編集する設計、admin 特権なし)
    expect(call.data).not.toHaveProperty('updatedBy');
  });

  it('Memo は visibility="public" も受理 (private→public の bulk 公開)', async () => {
    vi.mocked(prisma.memo.findMany).mockResolvedValue([
      { id: 'memo-1', userId: 'u-1', title: '正しいタイトル', content: '本文' },
    ] as never);
    vi.mocked(prisma.memo.updateMany).mockResolvedValue({ count: 1 } as never);

    const r = await bulkUpdateMemosVisibilityFromList(['memo-1'], 'public', 'u-1', 't-1');
    expect(r.updatedIds).toEqual(['memo-1']);
    expect(getMockCallArg(vi.mocked(prisma.memo.updateMany)).data).toEqual({ visibility: 'public' });
  });

  // 2026-05-11: 「自分のみ」(private) で空タイトル保存されたメモを「全メンバー」(public) に
  //   昇格させようとした場合、サーバ側 validator のルール (public はタイトル必須) と整合するため
  //   silent skip + skippedEmptyTitle を返す。
  it('private→public 化時に空タイトルの行はスキップ (個人情報漏洩 + UX 不整合の防止)', async () => {
    vi.mocked(prisma.memo.findMany).mockResolvedValue([
      { id: 'memo-1', userId: 'u-1', title: '正しいタイトル', content: '本文' },
      { id: 'memo-empty', userId: 'u-1', title: '', content: '本文' },
      { id: 'memo-space', userId: 'u-1', title: '   ', content: '本文' },
    ] as never);
    vi.mocked(prisma.memo.updateMany).mockResolvedValue({ count: 1 } as never);

    const r = await bulkUpdateMemosVisibilityFromList(
      ['memo-1', 'memo-empty', 'memo-space'],
      'public',
      'u-1',
      't-1',
    );

    expect(r.updatedIds).toEqual(['memo-1']);
    expect(r.skippedEmptyTitle).toBe(2);

    // updateMany は memo-1 のみが対象
    const call = getMockCallArg(vi.mocked(prisma.memo.updateMany));
    expect(call.where.id.in).toEqual(['memo-1']);
  });

  // v1.3.0 軽量入力 (2026-06-19): public 化は本文 (content) も非空必須。本文欠落行は skip。
  it('private→public 化時に本文が空の行はスキップ (v1.3.0)', async () => {
    vi.mocked(prisma.memo.findMany).mockResolvedValue([
      { id: 'memo-full', userId: 'u-1', title: 't', content: '本文' },
      { id: 'memo-nobody', userId: 'u-1', title: 't', content: '' },
    ] as never);
    vi.mocked(prisma.memo.updateMany).mockResolvedValue({ count: 1 } as never);

    const r = await bulkUpdateMemosVisibilityFromList(
      ['memo-full', 'memo-nobody'], 'public', 'u-1', 't-1',
    );

    expect(r.updatedIds).toEqual(['memo-full']);
    expect(r.skippedEmptyTitle).toBe(1);
  });

  it('private 化 (public→private) の場合は空タイトル行もそのまま通す (制約緩和方向)', async () => {
    vi.mocked(prisma.memo.findMany).mockResolvedValue([
      { id: 'memo-empty', userId: 'u-1', title: '' },
    ] as never);
    vi.mocked(prisma.memo.updateMany).mockResolvedValue({ count: 1 } as never);

    const r = await bulkUpdateMemosVisibilityFromList(['memo-empty'], 'private', 'u-1', 't-1');

    expect(r.updatedIds).toEqual(['memo-empty']);
    expect(r.skippedEmptyTitle).toBe(0);
  });

  // UI_PATTERNS §35 (2026-05-24): bulk visibility 経路の embedding コスト最適化テスト。
  // 単発 updateMemo の判定マトリクスと整合: private→public 遷移のみ embedding 対象。
  describe('embedding 生成 (コスト最適化)', () => {
    it('visibility=private への変更は embedding を生成しない (Voyage 課金回避)', async () => {
      vi.mocked(prisma.memo.findMany).mockResolvedValue([
        { id: 'memo-1', userId: 'u-1', title: 't', visibility: 'public', content: 'c' },
      ] as never);
      vi.mocked(prisma.memo.updateMany).mockResolvedValue({ count: 1 } as never);

      const r = await bulkUpdateMemosVisibilityFromList(['memo-1'], 'private', 'u-1', 't-1');
      expect(r.embeddingsGenerated).toBe(0);
      expect(generateAndPersistBatchEmbeddings).not.toHaveBeenCalled();
    });

    it('public→public のままなら embedding を生成しない (text 変更なしのため)', async () => {
      vi.mocked(prisma.memo.findMany).mockResolvedValue([
        { id: 'memo-1', userId: 'u-1', title: 't', visibility: 'public', content: 'c' },
      ] as never);
      vi.mocked(prisma.memo.updateMany).mockResolvedValue({ count: 1 } as never);

      const r = await bulkUpdateMemosVisibilityFromList(['memo-1'], 'public', 'u-1', 't-1');
      expect(r.embeddingsGenerated).toBe(0);
      expect(generateAndPersistBatchEmbeddings).not.toHaveBeenCalled();
    });

    it('private→public 遷移行のみ batch で 1 ApiCallLog 集約', async () => {
      vi.mocked(prisma.memo.findMany).mockResolvedValue([
        { id: 'memo-1', userId: 'u-1', title: 't1', visibility: 'private', content: 'c1' },
        { id: 'memo-2', userId: 'u-1', title: 't2', visibility: 'private', content: 'c2' },
        // 既 public は除外
        { id: 'memo-3', userId: 'u-1', title: 't3', visibility: 'public', content: 'c3' },
      ] as never);
      vi.mocked(prisma.memo.updateMany).mockResolvedValue({ count: 3 } as never);
      vi.mocked(generateAndPersistBatchEmbeddings).mockResolvedValue({ generated: 2, failed: 0, costJpy: 1 });

      const r = await bulkUpdateMemosVisibilityFromList(['memo-1', 'memo-2', 'memo-3'], 'public', 'u-1', 't-1');

      expect(r.embeddingsGenerated).toBe(2);
      expect(generateAndPersistBatchEmbeddings).toHaveBeenCalledTimes(1);
      const args = getMockCallArg(vi.mocked(generateAndPersistBatchEmbeddings));
      expect((args.items as unknown as Array<{ rowId: string }>).map((i) => i.rowId)).toEqual(['memo-1', 'memo-2']);
      expect(args.featureUnit).toBe('memo-embedding');
    });
  });
});

// (2026-05-15) Memo に embedding 生成が追加されたため、その visibility 別の API 呼出有無を検証する。
describe('Memo embedding (2026-05-15: visibility=public のみ生成)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('createMemo: visibility=private なら generateAndPersistEntityEmbedding は呼ばれない', async () => {
    vi.mocked(prisma.memo.create).mockResolvedValue(
      memoRow({ id: 'm-priv', visibility: 'private' }) as never,
    );
    await createMemo(
      { title: 'private memo', content: 'secret', visibility: 'private' },
      'user-1',
      'tenant-A',
    );
    expect(generateAndPersistEntityEmbedding).not.toHaveBeenCalled();
  });

  it('createMemo: visibility=public なら memo-embedding featureUnit で生成される', async () => {
    vi.mocked(prisma.memo.create).mockResolvedValue(
      memoRow({ id: 'm-pub', visibility: 'public' }) as never,
    );
    await createMemo(
      { title: '全員向けメモ', content: '共有内容', visibility: 'public' },
      'user-1',
      'tenant-A',
    );
    expect(generateAndPersistEntityEmbedding).toHaveBeenCalledOnce();
    const arg = getMockCallArg(vi.mocked(generateAndPersistEntityEmbedding));
    expect(arg.table).toBe('memos');
    expect(arg.rowId).toBe('m-pub');
    expect(arg.tenantId).toBe('tenant-A');
    expect(arg.featureUnit).toBe('memo-embedding');
    expect(arg.text).toContain('全員向けメモ');
    expect(arg.text).toContain('共有内容');
  });

  it('updateMemo: private → private は embedding 呼出なし (LLM 課金回避)', async () => {
    vi.mocked(prisma.memo.findFirst).mockResolvedValue({
      userId: 'user-1',
      title: 'old',
      content: 'old',
      visibility: 'private',
    } as never);
    vi.mocked(prisma.memo.update).mockResolvedValue(
      memoRow({ title: 'new', visibility: 'private' }) as never,
    );

    await updateMemo('memo-1', { title: 'new' }, 'user-1', 'tenant-A');

    expect(generateAndPersistEntityEmbedding).not.toHaveBeenCalled();
  });

  it('updateMemo: private → public は embedding 生成される (初回公開)', async () => {
    vi.mocked(prisma.memo.findFirst).mockResolvedValue({
      userId: 'user-1',
      title: 't',
      content: 'c',
      visibility: 'private',
    } as never);
    vi.mocked(prisma.memo.update).mockResolvedValue(
      memoRow({ visibility: 'public' }) as never,
    );

    await updateMemo('memo-1', { visibility: 'public' }, 'user-1', 'tenant-A');

    expect(generateAndPersistEntityEmbedding).toHaveBeenCalledOnce();
    expect(getMockCallArg(vi.mocked(generateAndPersistEntityEmbedding)).featureUnit).toBe(
      'memo-embedding',
    );
  });

  it('updateMemo: public → public で title/content 変更時は embedding 再生成', async () => {
    vi.mocked(prisma.memo.findFirst).mockResolvedValue({
      userId: 'user-1',
      title: 'old title',
      content: 'old content',
      visibility: 'public',
    } as never);
    vi.mocked(prisma.memo.update).mockResolvedValue(
      memoRow({ title: 'new title', visibility: 'public' }) as never,
    );

    await updateMemo('memo-1', { title: 'new title' }, 'user-1', 'tenant-A');

    expect(generateAndPersistEntityEmbedding).toHaveBeenCalledOnce();
  });

  it('updateMemo: public → public で対象項目変更なしなら embedding 呼出なし (LLM 課金回避)', async () => {
    vi.mocked(prisma.memo.findFirst).mockResolvedValue({
      userId: 'user-1',
      title: 'same',
      content: 'same',
      visibility: 'public',
    } as never);
    vi.mocked(prisma.memo.update).mockResolvedValue(
      memoRow({ title: 'same', visibility: 'public' }) as never,
    );

    // title/content いずれも変更しない (visibility だけ送信 or 同値送信)
    await updateMemo('memo-1', { title: 'same' }, 'user-1', 'tenant-A');

    expect(generateAndPersistEntityEmbedding).not.toHaveBeenCalled();
  });

  it('updateMemo: public → private は embedding 呼出なし (既存 embedding 保持)', async () => {
    vi.mocked(prisma.memo.findFirst).mockResolvedValue({
      userId: 'user-1',
      title: 't',
      content: 'c',
      visibility: 'public',
    } as never);
    vi.mocked(prisma.memo.update).mockResolvedValue(
      memoRow({ visibility: 'private' }) as never,
    );

    await updateMemo('memo-1', { visibility: 'private' }, 'user-1', 'tenant-A');

    expect(generateAndPersistEntityEmbedding).not.toHaveBeenCalled();
  });
});
