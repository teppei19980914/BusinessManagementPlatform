/**
 * テナントデータ一括インポートサービスの単体テスト (P-D / 2026-05-08)
 *
 * 検証項目:
 *   - テナント不在 → TENANT_NOT_FOUND
 *   - 不正な ZIP / 必須ファイル不足 → INVALID_ZIP / INVALID_FORMAT
 *   - in-flight ロック競合 → IMPORT_IN_PROGRESS
 *   - Beginner プランで席数超過 → BEGINNER_SEAT_LIMIT
 *   - Email 一致ユーザは既存に再マップ (新規作成しない)
 *   - 全エンティティの新規 UUID 採番 + FK 書き換え
 *   - 監査ログ (route.ts 側で記録) のための counts サマリ正確性
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import JSZip from 'jszip';

vi.mock('@/lib/db', () => {
  // ADR-0020 (2026-05-25): assertStorageLimitInTx が tx 経由で SELECT FOR UPDATE + tenant.findFirst
  //   + calculateTenantStorageBytesDynamic を呼ぶ。新スキーマ (storageBytesPeakThisMonth /
  //   storageGuardCircuitFailCount / storageGuardCircuitOpenedAt / dbCapacityWarningLevel) を返す。
  const tx = {
    user: { findMany: vi.fn(), create: vi.fn() },
    customer: { create: vi.fn() },
    project: { create: vi.fn() },
    task: { create: vi.fn() },
    estimate: { create: vi.fn() },
    projectMember: { findUnique: vi.fn(), create: vi.fn() },
    knowledge: { create: vi.fn() },
    knowledgeProject: { findUnique: vi.fn(), create: vi.fn() },
    riskIssue: { create: vi.fn() },
    retrospective: { create: vi.fn() },
    memo: { create: vi.fn() },
    stakeholder: { create: vi.fn() },
    comment: { create: vi.fn() },
    mention: { create: vi.fn() },
    attachment: { create: vi.fn() },
    tenant: {
      findFirst: vi.fn(async () => ({
        id: '11111111-1111-1111-1111-111111111111',
        storageBytesPeakThisMonth: BigInt(0),
        storageGuardCircuitFailCount: 0,
        storageGuardCircuitOpenedAt: null,
        dbCapacityWarningLevel: 'none',
      })),
      update: vi.fn(),
    },
    // SELECT FOR UPDATE 用 $queryRaw + 旧 $queryRaw もスタブ
    $queryRaw: vi.fn(async () => []),
  };
  return {
    prisma: {
      tenant: {
        findFirst: vi.fn(),
        updateMany: vi.fn(),
        update: vi.fn(),
      },
      user: { findMany: vi.fn(), count: vi.fn() },
      $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(tx)),
      // tx と同じインスタンスをエクスポート (テストから参照可能に)
      __tx: tx,
    },
  };
});

vi.mock('bcryptjs', () => ({
  hash: vi.fn(async () => '$2a$10$mock-hash'),
}));

// ADR-0020: storage-guard が動的計測サービス経由で集計するため mock 必要
vi.mock('@/services/tenant-storage-tables.service', () => ({
  calculateTenantStorageBytesDynamic: vi.fn(async () => BigInt(0)),
}));

vi.mock('@/services/error-log.service', () => ({
  recordError: vi.fn(),
}));

vi.mock('@/services/task.service', () => ({
  recalculateAllProjectWps: vi.fn(async () => ({ total: 0, updated: 0 })),
}));

import { importTenantData } from './data-import.service';
import { prisma } from '@/lib/db';
import { recalculateAllProjectWps } from '@/services/task.service';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const IMPORTER_ID = '22222222-2222-2222-2222-222222222222';

type MockedTx = {
  user: { findMany: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
  customer: { create: ReturnType<typeof vi.fn> };
  project: { create: ReturnType<typeof vi.fn> };
  task: { create: ReturnType<typeof vi.fn> };
  estimate: { create: ReturnType<typeof vi.fn> };
  projectMember: { findUnique: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
  knowledge: { create: ReturnType<typeof vi.fn> };
  knowledgeProject: { findUnique: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
  riskIssue: { create: ReturnType<typeof vi.fn> };
  retrospective: { create: ReturnType<typeof vi.fn> };
  memo: { create: ReturnType<typeof vi.fn> };
  stakeholder: { create: ReturnType<typeof vi.fn> };
  comment: { create: ReturnType<typeof vi.fn> };
  mention: { create: ReturnType<typeof vi.fn> };
  attachment: { create: ReturnType<typeof vi.fn> };
};

const tx = (prisma as unknown as { __tx: MockedTx }).__tx;

/** 最小限の有効な P-C エクスポート ZIP を作る (全 15 種類のファイル空配列) */
async function buildEmptyZip(overrides: Partial<Record<string, unknown[]>> = {}): Promise<Buffer> {
  const zip = new JSZip();
  const files = [
    'projects',
    'tasks',
    'estimates',
    'project_members',
    'knowledge',
    'knowledge_projects',
    'risks_issues',
    'retrospectives',
    'memos',
    'customers',
    'stakeholders',
    'comments',
    'mentions',
    'attachments',
    'users',
  ];
  for (const name of files) {
    zip.file(`data/${name}.json`, JSON.stringify(overrides[name] ?? []));
  }
  zip.file(
    'metadata.json',
    JSON.stringify({ exportedAt: '2026-05-08T00:00:00Z', tenantId: 'src-tenant' }),
  );
  const buf = await zip.generateAsync({ type: 'uint8array' });
  return Buffer.from(buf);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(recalculateAllProjectWps).mockResolvedValue({ total: 0, updated: 0 });
  vi.mocked(prisma.tenant.findFirst).mockResolvedValue({
    id: TENANT_ID,
    plan: 'expert',
    beginnerMaxSeats: 5,
    deletedAt: null,
  } as never);
  vi.mocked(prisma.user.findMany).mockResolvedValue([]);
  vi.mocked(prisma.tenant.updateMany).mockResolvedValue({ count: 1 } as never);
  vi.mocked(prisma.tenant.update).mockResolvedValue({} as never);

  tx.user.findMany.mockResolvedValue([]);
  tx.user.create.mockImplementation(async ({ data }) => data);
  tx.customer.create.mockImplementation(async ({ data }) => data);
  tx.project.create.mockImplementation(async ({ data }) => data);
  tx.task.create.mockImplementation(async ({ data }) => data);
  tx.estimate.create.mockImplementation(async ({ data }) => data);
  tx.projectMember.findUnique.mockResolvedValue(null);
  tx.projectMember.create.mockImplementation(async ({ data }) => data);
  tx.knowledge.create.mockImplementation(async ({ data }) => data);
  tx.knowledgeProject.findUnique.mockResolvedValue(null);
  tx.knowledgeProject.create.mockImplementation(async ({ data }) => data);
  tx.riskIssue.create.mockImplementation(async ({ data }) => data);
  tx.retrospective.create.mockImplementation(async ({ data }) => data);
  tx.memo.create.mockImplementation(async ({ data }) => data);
  tx.stakeholder.create.mockImplementation(async ({ data }) => data);
  tx.comment.create.mockImplementation(async ({ data }) => data);
  tx.mention.create.mockImplementation(async ({ data }) => data);
  tx.attachment.create.mockImplementation(async ({ data }) => data);
});

describe('importTenantData', () => {
  it('テナント不在 → TENANT_NOT_FOUND', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce(null);
    const zip = await buildEmptyZip();
    const r = await importTenantData(TENANT_ID, zip, IMPORTER_ID);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('TENANT_NOT_FOUND');
  });

  it('ZIP として読めない → INVALID_ZIP', async () => {
    const r = await importTenantData(TENANT_ID, Buffer.from('not a zip'), IMPORTER_ID);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('INVALID_ZIP');
  });

  it('必須ファイルが欠けている ZIP → INVALID_FORMAT', async () => {
    const zip = new JSZip();
    zip.file('data/projects.json', '[]');
    // 他のファイルなし
    const buf = Buffer.from(await zip.generateAsync({ type: 'uint8array' }));
    const r = await importTenantData(TENANT_ID, buf, IMPORTER_ID);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('INVALID_FORMAT');
  });

  it('in-flight ロック競合 → IMPORT_IN_PROGRESS', async () => {
    vi.mocked(prisma.tenant.updateMany).mockResolvedValueOnce({ count: 0 } as never);
    const zip = await buildEmptyZip();
    const r = await importTenantData(TENANT_ID, zip, IMPORTER_ID);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('IMPORT_IN_PROGRESS');
  });

  it('Beginner プランで合計席数超過 → BEGINNER_SEAT_LIMIT (新規 5 件 + 既存 1 件)', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce({
      id: TENANT_ID,
      plan: 'beginner',
      beginnerMaxSeats: 5,
      deletedAt: null,
    } as never);
    vi.mocked(prisma.user.findMany).mockResolvedValueOnce([
      { email: 'admin@example.com', isActive: true },
    ] as never);

    // 新規 active 5 名 (合計 6 で超過)
    const users = Array.from({ length: 5 }, (_, i) => ({
      id: `u-${i}`,
      name: `User${i}`,
      email: `user${i}@example.com`,
      systemRole: 'general',
      isActive: true,
    }));
    const zip = await buildEmptyZip({ users });
    const r = await importTenantData(TENANT_ID, zip, IMPORTER_ID);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('BEGINNER_SEAT_LIMIT');
  });

  it('Beginner プランで既存と同 email は merge 扱い → 席数超過しないので OK', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce({
      id: TENANT_ID,
      plan: 'beginner',
      beginnerMaxSeats: 5,
      deletedAt: null,
    } as never);
    vi.mocked(prisma.user.findMany).mockResolvedValueOnce([
      { email: 'admin@example.com', isActive: true },
    ] as never);
    tx.user.findMany.mockResolvedValueOnce([
      { id: 'existing-admin', email: 'admin@example.com' },
    ] as never);

    // 5 件中 1 件は既存と同 email → merge、新規 4 件 + 既存 1 = 5 で OK
    const users = [
      { id: 'u-1', name: 'Admin', email: 'ADMIN@example.com', isActive: true }, // 大文字違いでも一致
      { id: 'u-2', name: 'User2', email: 'u2@example.com', isActive: true },
      { id: 'u-3', name: 'User3', email: 'u3@example.com', isActive: true },
      { id: 'u-4', name: 'User4', email: 'u4@example.com', isActive: true },
      { id: 'u-5', name: 'User5', email: 'u5@example.com', isActive: true },
    ];
    const zip = await buildEmptyZip({ users });
    const r = await importTenantData(TENANT_ID, zip, IMPORTER_ID);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.summary.counts.usersCreated).toBe(4);
      expect(r.summary.counts.usersMerged).toBe(1);
    }
  });

  it('空 ZIP のインポートは 0 件で成功し、ロック解放まで実行される', async () => {
    const zip = await buildEmptyZip();
    const r = await importTenantData(TENANT_ID, zip, IMPORTER_ID);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.summary.tenantId).toBe(TENANT_ID);
      expect(r.summary.counts.projects).toBe(0);
    }
    // ロック取得 + 解放が両方呼ばれた
    expect(prisma.tenant.updateMany).toHaveBeenCalled();
    expect(prisma.tenant.update).toHaveBeenCalledWith({
      where: { id: TENANT_ID },
      data: { importInProgressAt: null },
    });
  });

  it('全エンティティが tenantId スコープで作成され、FK が新 UUID に書き換えられる', async () => {
    const zip = await buildEmptyZip({
      users: [
        { id: 'u-1', name: 'Alice', email: 'alice@example.com', systemRole: 'admin', isActive: true },
      ],
      customers: [
        { id: 'c-1', name: 'Customer A', createdBy: 'u-1', updatedBy: 'u-1' },
      ],
      projects: [
        {
          id: 'p-1',
          name: 'Project1',
          customerId: 'c-1',
          purpose: 'p',
          background: 'b',
          scope: 's',
          devMethod: 'waterfall',
          plannedStartDate: '2026-01-01',
          plannedEndDate: '2026-12-31',
          status: 'planning',
          businessDomainTags: [],
          techStackTags: [],
          processTags: [],
          createdBy: 'u-1',
          updatedBy: 'u-1',
        },
      ],
      knowledge: [
        {
          id: 'k-1',
          title: 'Knowledge1',
          knowledgeType: 'general',
          background: 'b',
          content: 'c',
          result: 'r',
          techTags: [],
          processTags: [],
          businessDomainTags: [],
          visibility: 'draft',
          createdBy: 'u-1',
          updatedBy: 'u-1',
        },
      ],
      knowledge_projects: [{ id: 'kp-1', knowledgeId: 'k-1', projectId: 'p-1' }],
    });

    const r = await importTenantData(TENANT_ID, zip, IMPORTER_ID);
    expect(r.ok).toBe(true);

    // user.create が tenantId スコープ + 新 UUID で呼ばれた
    expect(tx.user.create).toHaveBeenCalledTimes(1);
    const userCall = tx.user.create.mock.calls[0]![0];
    expect(userCall.data.tenantId).toBe(TENANT_ID);
    expect(userCall.data.id).not.toBe('u-1'); // 新規 UUID
    expect(userCall.data.email).toBe('alice@example.com');
    expect(userCall.data.forcePasswordChange).toBe(true);

    // project.create が新規 customerId + 新 UUID で呼ばれた
    expect(tx.project.create).toHaveBeenCalledTimes(1);
    const projectCall = tx.project.create.mock.calls[0]![0];
    expect(projectCall.data.tenantId).toBe(TENANT_ID);
    expect(projectCall.data.id).not.toBe('p-1');
    expect(projectCall.data.customerId).not.toBe('c-1');
    expect(projectCall.data.createdBy).not.toBe('u-1');

    // knowledge_projects も書き換え済 ID を使用
    expect(tx.knowledgeProject.create).toHaveBeenCalledTimes(1);
    const kpCall = tx.knowledgeProject.create.mock.calls[0]![0];
    expect(kpCall.data.knowledgeId).not.toBe('k-1');
    expect(kpCall.data.projectId).not.toBe('p-1');
  });

  it('Task の自己参照 parentTaskId が新 UUID に書き換えられ、親が先に挿入される', async () => {
    const zip = await buildEmptyZip({
      users: [{ id: 'u-1', name: 'A', email: 'a@example.com', systemRole: 'general', isActive: true }],
      customers: [{ id: 'c-1', name: 'CustomerA', createdBy: 'u-1', updatedBy: 'u-1' }],
      projects: [
        {
          id: 'p-1',
          name: 'P1',
          customerId: 'c-1',
          purpose: 'p',
          background: 'b',
          scope: 's',
          devMethod: 'waterfall',
          plannedStartDate: '2026-01-01',
          plannedEndDate: '2026-12-31',
          status: 'planning',
          businessDomainTags: [],
          techStackTags: [],
          processTags: [],
          createdBy: 'u-1',
          updatedBy: 'u-1',
        },
      ],
      tasks: [
        // 子を先に並べてもソートで親優先になる
        {
          id: 't-child',
          projectId: 'p-1',
          parentTaskId: 't-parent',
          name: 'Child',
          category: 'dev',
          plannedEffort: 1,
          progressRate: 0,
          createdBy: 'u-1',
          updatedBy: 'u-1',
        },
        {
          id: 't-parent',
          projectId: 'p-1',
          parentTaskId: null,
          name: 'Parent',
          category: 'dev',
          plannedEffort: 2,
          progressRate: 0,
          createdBy: 'u-1',
          updatedBy: 'u-1',
        },
      ],
    });

    const r = await importTenantData(TENANT_ID, zip, IMPORTER_ID);
    expect(r.ok).toBe(true);

    expect(tx.task.create).toHaveBeenCalledTimes(2);
    const firstCall = tx.task.create.mock.calls[0]![0];
    const secondCall = tx.task.create.mock.calls[1]![0];

    // 親優先 (= parentTaskId null) で挿入されている
    expect(firstCall.data.parentTaskId).toBeNull();
    expect(secondCall.data.parentTaskId).toBe(firstCall.data.id); // 子の parent は親の new UUID
    expect(firstCall.data.id).not.toBe('t-parent');
    expect(secondCall.data.id).not.toBe('t-child');
  });

  it('Comments の polymorphic entityId が entityType に応じて書き換えられ、Mention も commentId 経由で挿入される', async () => {
    const zip = await buildEmptyZip({
      users: [{ id: 'u-1', name: 'A', email: 'a@example.com', systemRole: 'general', isActive: true }],
      customers: [{ id: 'c-1', name: 'CustomerA', createdBy: 'u-1', updatedBy: 'u-1' }],
      projects: [
        {
          id: 'p-1',
          name: 'P1',
          customerId: 'c-1',
          purpose: 'p',
          background: 'b',
          scope: 's',
          devMethod: 'waterfall',
          plannedStartDate: '2026-01-01',
          plannedEndDate: '2026-12-31',
          status: 'planning',
          businessDomainTags: [],
          techStackTags: [],
          processTags: [],
          createdBy: 'u-1',
          updatedBy: 'u-1',
        },
      ],
      knowledge: [
        {
          id: 'k-1',
          title: 'K',
          knowledgeType: 'general',
          background: '',
          content: '',
          result: '',
          techTags: [],
          processTags: [],
          businessDomainTags: [],
          visibility: 'draft',
          createdBy: 'u-1',
          updatedBy: 'u-1',
        },
      ],
      comments: [
        { id: 'cm-1', entityType: 'knowledge', entityId: 'k-1', userId: 'u-1', content: 'c1' },
        { id: 'cm-orphan', entityType: 'task', entityId: 't-missing', userId: 'u-1', content: 'orphan' },
      ],
      mentions: [{ id: 'me-1', commentId: 'cm-1', kind: 'all' }],
    });

    const r = await importTenantData(TENANT_ID, zip, IMPORTER_ID);
    expect(r.ok).toBe(true);

    // orphan は skip (1 件のみ作成)
    expect(tx.comment.create).toHaveBeenCalledTimes(1);
    const commentCall = tx.comment.create.mock.calls[0]![0];
    expect(commentCall.data.entityType).toBe('knowledge');
    expect(commentCall.data.entityId).not.toBe('k-1'); // 新規 UUID

    // mention も親 comment が作成されたものだけ
    expect(tx.mention.create).toHaveBeenCalledTimes(1);
    const mentionCall = tx.mention.create.mock.calls[0]![0];
    expect(mentionCall.data.commentId).toBe(commentCall.data.id);
  });

  it('インポート例外時もロックが解放される', async () => {
    // $transaction が例外を投げる
    vi.mocked(prisma.$transaction).mockRejectedValueOnce(new Error('boom'));
    const zip = await buildEmptyZip();
    await expect(importTenantData(TENANT_ID, zip, IMPORTER_ID)).rejects.toThrow('boom');
    expect(prisma.tenant.update).toHaveBeenCalledWith({
      where: { id: TENANT_ID },
      data: { importInProgressAt: null },
    });
  });

  // ================================================================
  // S-2 (PHASE2_THREAT_MODEL.md / 2026-05-08): users.systemRole を 'general' 固定
  // ================================================================
  it('S-2: ZIP の users.systemRole=admin であっても DB には general で作成される', async () => {
    const zip = await buildEmptyZip({
      users: [
        // 攻撃者が ZIP を改ざんして admin 偽装を試行
        { id: 'u-1', name: 'Attacker', email: 'a@example.com', systemRole: 'admin', isActive: true },
        // 通常の general
        { id: 'u-2', name: 'Normal', email: 'n@example.com', systemRole: 'general', isActive: true },
        // super_admin 偽装試行も同じく無効化される
        { id: 'u-3', name: 'Super', email: 's@example.com', systemRole: 'super_admin', isActive: true },
      ],
    });

    const r = await importTenantData(TENANT_ID, zip, IMPORTER_ID);
    expect(r.ok).toBe(true);

    expect(tx.user.create).toHaveBeenCalledTimes(3);
    for (const call of tx.user.create.mock.calls) {
      const data = call[0]!.data as { systemRole: string };
      // ZIP の値に関わらず必ず 'general' で作成される
      expect(data.systemRole).toBe('general');
    }
  });

  // ================================================================
  // 追記モード (2026-06-27): ZIP インポートは既存データを削除せず新規追加のみ行う
  // ================================================================
  it('追記モード: 既存と同 email のユーザは create されず merge カウントのみ増加する', async () => {
    tx.user.findMany.mockResolvedValueOnce([
      { id: 'existing-1', email: 'admin@example.com' },
      { id: 'existing-2', email: 'user2@example.com' },
    ] as never);

    const zip = await buildEmptyZip({
      users: [
        // 既存と同 email (大小文字違い) → merge
        { id: 'u-a', name: 'Admin', email: 'ADMIN@example.com', systemRole: 'admin', isActive: true },
        // 既存と同 email → merge
        { id: 'u-b', name: 'User2', email: 'user2@example.com', systemRole: 'general', isActive: true },
        // 新規 email → create
        { id: 'u-c', name: 'New1', email: 'new1@example.com', systemRole: 'general', isActive: true },
        // 新規 email → create
        { id: 'u-d', name: 'New2', email: 'new2@example.com', systemRole: 'general', isActive: true },
      ],
    });

    const r = await importTenantData(TENANT_ID, zip, IMPORTER_ID);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.summary.counts.usersCreated).toBe(2);
      expect(r.summary.counts.usersMerged).toBe(2);
    }
    // 新規 2 件のみ create される (既存 2 件は create されない)
    expect(tx.user.create).toHaveBeenCalledTimes(2);
    const createdEmails = tx.user.create.mock.calls.map(
      (c) => (c[0] as { data: { email: string } }).data.email,
    );
    expect(createdEmails).toContain('new1@example.com');
    expect(createdEmails).toContain('new2@example.com');
    expect(createdEmails).not.toContain('admin@example.com');
    expect(createdEmails).not.toContain('user2@example.com');
  });

  it('追記モード: 既存テナント管理者の systemRole / isActive は ZIP 側の値で上書きされない', async () => {
    // 既存 admin ユーザ (tenant-admin) が ZIP に general として含まれていても属性は変わらない
    tx.user.findMany.mockResolvedValueOnce([
      { id: 'existing-admin', email: 'admin@company.com' },
    ] as never);

    const zip = await buildEmptyZip({
      users: [
        // ZIP 側では general だが既存は admin → 属性更新禁止
        { id: 'u-old', name: 'Admin', email: 'admin@company.com', systemRole: 'general', isActive: false },
      ],
    });

    const r = await importTenantData(TENANT_ID, zip, IMPORTER_ID);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.summary.counts.usersMerged).toBe(1);
      expect(r.summary.counts.usersCreated).toBe(0);
    }
    // create / update いずれも呼ばれていない (ID 再マップのみ)
    expect(tx.user.create).not.toHaveBeenCalled();
  });

  it('追記モード: 新規インポートユーザに invitationAcceptedAt が設定され forcePasswordChange が true になる', async () => {
    const zip = await buildEmptyZip({
      users: [
        { id: 'u-1', name: 'NewUser', email: 'newuser@example.com', systemRole: 'general', isActive: true },
      ],
    });

    const r = await importTenantData(TENANT_ID, zip, IMPORTER_ID);
    expect(r.ok).toBe(true);

    expect(tx.user.create).toHaveBeenCalledTimes(1);
    const createdData = tx.user.create.mock.calls[0]![0].data as {
      invitationAcceptedAt: unknown;
      forcePasswordChange: boolean;
      systemRole: string;
    };
    // 招待中ではなく有効として作成 (招待取り消し経路を防ぐ)
    expect(createdData.invitationAcceptedAt).toBeInstanceOf(Date);
    expect(createdData.forcePasswordChange).toBe(true);
    // S-2: systemRole は常に general
    expect(createdData.systemRole).toBe('general');
  });

  // ================================================================
  // D-1 (PHASE2_THREAT_MODEL.md / 2026-05-08): ZIP 解凍後サイズ上限 200MB
  // ================================================================
  it('インポート成功後に recalculateAllProjectWps が各プロジェクト × tenantId で呼ばれる', async () => {
    const zip = await buildEmptyZip({
      users: [{ id: 'u-1', name: 'Alice', email: 'alice@example.com', systemRole: 'general', isActive: true }],
      customers: [{ id: 'c-1', name: 'Customer A', createdBy: 'u-1', updatedBy: 'u-1' }],
      projects: [
        {
          id: 'p-1', name: 'Project1', customerId: 'c-1', purpose: 'p', background: 'b', scope: 's',
          devMethod: 'waterfall', plannedStartDate: '2026-01-01', plannedEndDate: '2026-12-31',
          status: 'planning', businessDomainTags: [], techStackTags: [], processTags: [],
          createdBy: 'u-1', updatedBy: 'u-1',
        },
        {
          id: 'p-2', name: 'Project2', customerId: 'c-1', purpose: 'p', background: 'b', scope: 's',
          devMethod: 'waterfall', plannedStartDate: '2026-01-01', plannedEndDate: '2026-12-31',
          status: 'planning', businessDomainTags: [], techStackTags: [], processTags: [],
          createdBy: 'u-1', updatedBy: 'u-1',
        },
      ],
    });

    const r = await importTenantData(TENANT_ID, zip, IMPORTER_ID);
    expect(r.ok).toBe(true);

    // プロジェクト 2 件分だけ呼ばれる
    expect(recalculateAllProjectWps).toHaveBeenCalledTimes(2);
    // 各呼び出しの第 2 引数がテナント ID
    const calls = vi.mocked(recalculateAllProjectWps).mock.calls;
    expect(calls.every(([, tid]) => tid === TENANT_ID)).toBe(true);
    // 第 1 引数は新規採番された UUID (= 元の p-1 / p-2 とは異なる)
    const calledProjectIds = calls.map(([pid]) => pid);
    expect(calledProjectIds).not.toContain('p-1');
    expect(calledProjectIds).not.toContain('p-2');
  });

  it('recalculateAllProjectWps が例外を投げてもインポート結果は ok:true を返す', async () => {
    vi.mocked(recalculateAllProjectWps).mockRejectedValueOnce(new Error('recalc failed'));

    const zip = await buildEmptyZip({
      users: [{ id: 'u-1', name: 'Bob', email: 'bob@example.com', systemRole: 'general', isActive: true }],
      customers: [{ id: 'c-1', name: 'C', createdBy: 'u-1', updatedBy: 'u-1' }],
      projects: [
        {
          id: 'p-1', name: 'P', customerId: 'c-1', purpose: 'p', background: 'b', scope: 's',
          devMethod: 'waterfall', plannedStartDate: '2026-01-01', plannedEndDate: '2026-12-31',
          status: 'planning', businessDomainTags: [], techStackTags: [], processTags: [],
          createdBy: 'u-1', updatedBy: 'u-1',
        },
      ],
    });

    const r = await importTenantData(TENANT_ID, zip, IMPORTER_ID);
    // fail-open: 再計算が失敗してもインポート自体は成功扱い
    expect(r.ok).toBe(true);
  });

  it('D-1: ZIP 解凍後合計サイズが 200MB 超過 → DECOMPRESSED_TOO_LARGE', async () => {
    // 軽量化: 実際に 250MB の JSON を生成すると CI でタイムアウトするので、
    // 通常 ZIP をロード後 jszip 内部の `_data.uncompressedSize` を直接書き換えて
    // 「解凍後 250MB」と service が認識する状態を作る。
    const baseZip = await buildEmptyZip();
    const JSZipModule = await import('jszip');
    const loaded = await JSZipModule.default.loadAsync(baseZip);

    // data/projects.json の内部 uncompressedSize を 250MB に偽装
    const projectsFile = loaded.file('data/projects.json');
    if (projectsFile) {
      (projectsFile as unknown as { _data: { uncompressedSize: number } })._data.uncompressedSize =
        250 * 1024 * 1024;
    }

    // service は zip.files から直接 uncompressedSize を読むため、loaded を渡せば判定発火する。
    // ただし importTenantData は Buffer 経由で再 load するので、jszip mock を使う必要がある。
    // 最もシンプルな経路: JSZip.loadAsync をスパイして loaded を返す形で service を実行。
    const jszipDefault = JSZipModule.default;
    const spy = vi.spyOn(jszipDefault, 'loadAsync').mockResolvedValueOnce(loaded);

    const r = await importTenantData(TENANT_ID, baseZip, IMPORTER_ID);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('DECOMPRESSED_TOO_LARGE');
    spy.mockRestore();
  });
});
