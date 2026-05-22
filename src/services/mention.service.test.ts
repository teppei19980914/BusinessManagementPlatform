import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findMany: vi.fn() },
    projectMember: { findMany: vi.fn() },
    task: { findFirst: vi.fn() },
    riskIssue: { findFirst: vi.fn() },
    retrospective: { findFirst: vi.fn() },
    knowledge: { findFirst: vi.fn() },
    stakeholder: { findFirst: vi.fn() },
    customer: { findFirst: vi.fn() },
    notification: { createMany: vi.fn() },
  },
}));

import {
  validateMentionsForEntity,
  expandMention,
  expandMentionsToRecipients,
  diffMentions,
  generateMentionNotifications,
  getMentionContext,
  mentionKey,
} from './mention.service';
import { prisma } from '@/lib/db';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('validateMentionsForEntity', () => {
  it('issue では全 kind が許容', () => {
    const r = validateMentionsForEntity('issue', [
      { kind: 'all' },
      { kind: 'project_member' },
      { kind: 'role_pm_tl' },
      { kind: 'assignee' },
    ]);
    expect(r.ok).toBe(true);
  });

  it('task で all は拒否 (Q3)', () => {
    const r = validateMentionsForEntity('task', [{ kind: 'all' }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('all');
  });

  it('customer は user のみ許容', () => {
    expect(validateMentionsForEntity('customer', [{ kind: 'user', targetUserId: 'u1' }]).ok).toBe(true);
    expect(validateMentionsForEntity('customer', [{ kind: 'all' }]).ok).toBe(false);
    expect(validateMentionsForEntity('customer', [{ kind: 'project_member' }]).ok).toBe(false);
  });
});

describe('expandMention', () => {
  it('kind=user は targetUserId をそのまま返す', async () => {
    const r = await expandMention(
      { kind: 'user', targetUserId: 'u-1' },
      { projectId: 'p-1', assigneeId: null },
      'tenant-A',
    );
    expect(r).toEqual(['u-1']);
  });

  it('kind=all は active な全ユーザを返す', async () => {
    vi.mocked(prisma.user.findMany).mockResolvedValue([
      { id: 'u-1' }, { id: 'u-2' },
    ] as never);
    const r = await expandMention({ kind: 'all' }, { projectId: null, assigneeId: null }, 'tenant-A');
    expect(r).toEqual(['u-1', 'u-2']);
    const call = vi.mocked(prisma.user.findMany).mock.calls[0][0];
    expect(call?.where).toMatchObject({ tenantId: 'tenant-A', isActive: true, deletedAt: null, permanentLock: false });
  });

  it('kind=project_member は projectId のメンバーを返す', async () => {
    vi.mocked(prisma.projectMember.findMany).mockResolvedValue([
      { userId: 'u-a' }, { userId: 'u-b' },
    ] as never);
    const r = await expandMention(
      { kind: 'project_member' },
      { projectId: 'p-1', assigneeId: null },
      'tenant-A',
    );
    expect(r).toEqual(['u-a', 'u-b']);
    const call = vi.mocked(prisma.projectMember.findMany).mock.calls[0][0];
    expect(call?.where).toEqual({ projectId: 'p-1' });
  });

  it('kind=role_pm_tl は projectRole=pm_tl で絞る', async () => {
    vi.mocked(prisma.projectMember.findMany).mockResolvedValue([{ userId: 'u-pm' }] as never);
    await expandMention({ kind: 'role_pm_tl' }, { projectId: 'p-1', assigneeId: null }, 'tenant-A');
    const call = vi.mocked(prisma.projectMember.findMany).mock.calls[0][0];
    expect(call?.where).toEqual({ projectId: 'p-1', projectRole: 'pm_tl' });
  });

  it('kind=role_general は projectRole=member で絞る', async () => {
    vi.mocked(prisma.projectMember.findMany).mockResolvedValue([] as never);
    await expandMention({ kind: 'role_general' }, { projectId: 'p-1', assigneeId: null }, 'tenant-A');
    const call = vi.mocked(prisma.projectMember.findMany).mock.calls[0][0];
    expect(call?.where).toEqual({ projectId: 'p-1', projectRole: 'member' });
  });

  it('kind=role_viewer は projectRole=viewer で絞る', async () => {
    vi.mocked(prisma.projectMember.findMany).mockResolvedValue([] as never);
    await expandMention({ kind: 'role_viewer' }, { projectId: 'p-1', assigneeId: null }, 'tenant-A');
    const call = vi.mocked(prisma.projectMember.findMany).mock.calls[0][0];
    expect(call?.where).toEqual({ projectId: 'p-1', projectRole: 'viewer' });
  });

  it('kind=assignee は context.assigneeId を返す', async () => {
    const r = await expandMention(
      { kind: 'assignee' },
      { projectId: 'p-1', assigneeId: 'u-as' },
      'tenant-A',
    );
    expect(r).toEqual(['u-as']);
  });

  it('kind=assignee で context.assigneeId が null なら空配列', async () => {
    const r = await expandMention(
      { kind: 'assignee' },
      { projectId: 'p-1', assigneeId: null },
      'tenant-A',
    );
    expect(r).toEqual([]);
  });

  it('project_member で projectId が null なら空配列 (knowledge orphan 等)', async () => {
    const r = await expandMention(
      { kind: 'project_member' },
      { projectId: null, assigneeId: null },
      'tenant-A',
    );
    expect(r).toEqual([]);
    expect(prisma.projectMember.findMany).not.toHaveBeenCalled();
  });
});

describe('expandMentionsToRecipients', () => {
  it('複数 mention を重複排除して set 化、自分宛は除外 (Q5)', async () => {
    vi.mocked(prisma.user.findMany).mockResolvedValue([
      { id: 'u-1' }, { id: 'u-self' }, { id: 'u-2' },
    ] as never);
    vi.mocked(prisma.projectMember.findMany).mockResolvedValue([
      { userId: 'u-1' }, { userId: 'u-3' },
    ] as never);

    const r = await expandMentionsToRecipients(
      [{ kind: 'all' }, { kind: 'project_member' }],
      { projectId: 'p-1', assigneeId: null },
      'u-self',
      'tenant-A',
    );
    expect(Array.from(r).sort()).toEqual(['u-1', 'u-2', 'u-3']);
    expect(r.has('u-self')).toBe(false);
  });
});

describe('diffMentions', () => {
  it('追加分 / 削除分を分離', () => {
    const old = [
      { id: 'm1', kind: 'all', targetUserId: null },
      { id: 'm2', kind: 'user', targetUserId: 'u-1' },
    ];
    const newInputs = [
      { kind: 'all' as const },
      { kind: 'user' as const, targetUserId: 'u-2' }, // 新規
      { kind: 'role_pm_tl' as const }, // 新規
    ];
    const { added, removedIds } = diffMentions(old, newInputs);
    expect(added).toEqual([
      { kind: 'user', targetUserId: 'u-2' },
      { kind: 'role_pm_tl' },
    ]);
    expect(removedIds).toEqual(['m2']);
  });

  it('mentionKey は kind + targetUserId で同一性判定', () => {
    expect(mentionKey({ kind: 'all', targetUserId: null })).toBe('all:');
    expect(mentionKey({ kind: 'user', targetUserId: 'u-1' })).toBe('user:u-1');
  });
});

describe('getMentionContext', () => {
  it('task: projectId + assigneeId を返す', async () => {
    vi.mocked(prisma.task.findFirst).mockResolvedValue({ projectId: 'p-1', assigneeId: 'u-1' } as never);
    const r = await getMentionContext('task', 't-1', 'tenant-A');
    expect(r).toEqual({ projectId: 'p-1', assigneeId: 'u-1' });
  });

  it('retrospective: assigneeId は常に null', async () => {
    vi.mocked(prisma.retrospective.findFirst).mockResolvedValue({ projectId: 'p-1' } as never);
    const r = await getMentionContext('retrospective', 'rt-1', 'tenant-A');
    expect(r).toEqual({ projectId: 'p-1', assigneeId: null });
  });

  it('customer: projectId / assigneeId とも null', async () => {
    vi.mocked(prisma.customer.findFirst).mockResolvedValue({ id: 'c-1' } as never);
    const r = await getMentionContext('customer', 'c-1', 'tenant-A');
    expect(r).toEqual({ projectId: null, assigneeId: null });
  });

  it('not-found なら null', async () => {
    vi.mocked(prisma.task.findFirst).mockResolvedValue(null);
    const r = await getMentionContext('task', 'missing', 'tenant-A');
    expect(r).toBeNull();
  });
});

describe('generateMentionNotifications', () => {
  it('受信者ごとに Notification を一括 createMany + PR #425: title に entity 情報を含む', async () => {
    // PR #425 (2026-05-22): mock に name / parentTask / project.name を追加。
    //   resolveEntityLabelForMention が同じ prisma.task.findFirst を呼ぶため、
    //   getMentionContext と兼用できるよう必要なフィールドを mock 値に含める。
    vi.mocked(prisma.task.findFirst).mockResolvedValue({
      projectId: 'p-1',
      assigneeId: null,
      name: 'ACT2 設計レビュー',
      parentTask: { name: 'WP1 要件定義' },
      project: { name: 'Project A' },
    } as never);
    vi.mocked(prisma.projectMember.findMany).mockResolvedValue([
      { userId: 'u-a' }, { userId: 'u-b' },
    ] as never);
    vi.mocked(prisma.notification.createMany).mockResolvedValue({ count: 2 } as never);

    const r = await generateMentionNotifications({
      commentId: 'c-1',
      comment: { entityType: 'task', entityId: 't-1' },
      mentions: [{ kind: 'project_member' }],
      mentionerId: 'u-mentioner',
      mentionerName: '田中',
      link: '/projects/p-1/tasks?taskId=t-1',
      tenantId: 'tenant-A',
    });
    expect(r.created).toBe(2);
    const call = vi.mocked(prisma.notification.createMany).mock.calls[0][0];
    const data = call?.data as Array<{ userId: string; type: string; dedupeKey: string; title: string }>;
    expect(data).toHaveLength(2);
    expect(data.every((n) => n.type === 'comment_mention')).toBe(true);
    expect(data.every((n) => n.dedupeKey.startsWith('comment_mention:c-1:'))).toBe(true);
    // PR #425: 新文言「[プロジェクト名] タスク「親WP / ACT名」で {sender}さんがコメントでメンションしました」
    expect(data[0].title).toBe(
      '[Project A] タスク「WP1 要件定義 / ACT2 設計レビュー」で 田中さんがコメントでメンションしました',
    );
    expect(call?.skipDuplicates).toBe(true);
  });

  // PR #425 (2026-05-22): buildMentionNotificationTitle ヘルパの単体テスト
  it('buildMentionNotificationTitle: entityLabel が null ならフォールバック旧文言', async () => {
    const { buildMentionNotificationTitle } = await import('./mention.service');
    expect(
      buildMentionNotificationTitle({
        senderLabel: '田中',
        entityLabel: null,
        projectName: null,
      }),
    ).toBe('田中さんがコメントであなたをメンションしました');
  });

  it('buildMentionNotificationTitle: projectName が null/空 なら接頭辞省略', async () => {
    const { buildMentionNotificationTitle } = await import('./mention.service');
    expect(
      buildMentionNotificationTitle({
        senderLabel: '田中',
        entityLabel: 'ナレッジ「テストナレッジ」',
        projectName: null,
      }),
    ).toBe('ナレッジ「テストナレッジ」で 田中さんがコメントでメンションしました');
  });

  it('buildMentionNotificationTitle: project + entity 両方あれば完全形', async () => {
    const { buildMentionNotificationTitle } = await import('./mention.service');
    expect(
      buildMentionNotificationTitle({
        senderLabel: '田中',
        entityLabel: 'リスク「サーバ停止」',
        projectName: 'Project A',
      }),
    ).toBe('[Project A] リスク「サーバ停止」で 田中さんがコメントでメンションしました');
  });

  it('mentions 空なら DB に触らない (early return)', async () => {
    const r = await generateMentionNotifications({
      commentId: 'c-1',
      comment: { entityType: 'task', entityId: 't-1' },
      mentions: [],
      mentionerId: 'u-1',
      mentionerName: null,
      link: '',
    });
    expect(r.created).toBe(0);
    expect(prisma.notification.createMany).not.toHaveBeenCalled();
  });

  it('受信者 0 件 (自分しかいない) なら createMany を呼ばない', async () => {
    vi.mocked(prisma.task.findFirst).mockResolvedValue({ projectId: 'p-1', assigneeId: 'u-self' } as never);
    const r = await generateMentionNotifications({
      commentId: 'c-1',
      comment: { entityType: 'task', entityId: 't-1' },
      mentions: [{ kind: 'assignee' }],
      mentionerId: 'u-self', // assignee = 自分 → 除外で 0 件
      mentionerName: null,
      link: '',
      tenantId: 'tenant-A',
    });
    expect(r.created).toBe(0);
    expect(prisma.notification.createMany).not.toHaveBeenCalled();
  });

  it('entity 削除済 (context null) なら createMany を呼ばない', async () => {
    vi.mocked(prisma.task.findFirst).mockResolvedValue(null);
    const r = await generateMentionNotifications({
      commentId: 'c-1',
      comment: { entityType: 'task', entityId: 'missing' },
      mentions: [{ kind: 'all' }],
      mentionerId: 'u-1',
      mentionerName: null,
      link: '',
    });
    expect(r.created).toBe(0);
  });
});
