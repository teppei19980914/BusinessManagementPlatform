import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  prisma: {
    notification: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      count: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      createMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    task: {
      findMany: vi.fn(),
    },
  },
}));

import {
  listNotificationsForUser,
  setNotificationRead,
  markAllNotificationsRead,
  generateDailyNotifications,
  cleanupReadNotifications,
  todayInJst,
} from './notification.service';
import { prisma } from '@/lib/db';

const NOW_UTC = new Date('2026-05-01T22:00:00Z'); // = JST 2026-05-02 07:00 (cron 実行想定時刻)

beforeEach(() => {
  vi.clearAllMocks();
});

describe('todayInJst', () => {
  it('UTC 22:00 (cron 実行時) は JST 翌日扱い', () => {
    const d = todayInJst(NOW_UTC);
    // JST 2026-05-02 → UTC 0:00 で表現される 2026-05-02
    expect(d.toISOString().slice(0, 10)).toBe('2026-05-02');
  });

  it('UTC 14:59 (JST 23:59) は JST 同日', () => {
    const d = todayInJst(new Date('2026-05-02T14:59:00Z'));
    expect(d.toISOString().slice(0, 10)).toBe('2026-05-02');
  });

  it('UTC 15:00 (JST 翌日 00:00) は JST 翌日', () => {
    const d = todayInJst(new Date('2026-05-02T15:00:00Z'));
    expect(d.toISOString().slice(0, 10)).toBe('2026-05-03');
  });
});

describe('listNotificationsForUser', () => {
  it('default は未読のみ + unreadCount を同時返却', async () => {
    vi.mocked(prisma.notification.findMany).mockResolvedValue([
      { id: 'n1', type: 'task_start_due', entityType: 'task', entityId: 't1', title: 't', link: '/x', readAt: null, createdAt: NOW_UTC },
    ] as never);
    vi.mocked(prisma.notification.count).mockResolvedValue(3 as never);

    const r = await listNotificationsForUser('u-1');
    expect(r.unreadCount).toBe(3);
    expect(r.items).toHaveLength(1);
    const findCall = vi.mocked(prisma.notification.findMany).mock.calls[0][0];
    expect(findCall?.where).toEqual({ userId: 'u-1', readAt: null });
  });

  it('includeRead=true で既読も含める', async () => {
    vi.mocked(prisma.notification.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.notification.count).mockResolvedValue(0 as never);

    await listNotificationsForUser('u-1', { includeRead: true });
    const findCall = vi.mocked(prisma.notification.findMany).mock.calls[0][0];
    expect(findCall?.where).toEqual({ userId: 'u-1' });
  });
});

describe('setNotificationRead / markAllNotificationsRead', () => {
  it('setNotificationRead(true) は readAt をセット', async () => {
    vi.mocked(prisma.notification.update).mockResolvedValue({
      id: 'n1', type: 'task_start_due', entityType: 'task', entityId: 't1',
      title: 't', link: '/x', readAt: NOW_UTC, createdAt: NOW_UTC,
    } as never);

    const r = await setNotificationRead('n1', true);
    expect(r.readAt).not.toBeNull();
    const call = vi.mocked(prisma.notification.update).mock.calls[0][0];
    expect(call?.data.readAt).toBeInstanceOf(Date);
  });

  it('setNotificationRead(false) は readAt を null にする', async () => {
    vi.mocked(prisma.notification.update).mockResolvedValue({
      id: 'n1', type: 'task_start_due', entityType: 'task', entityId: 't1',
      title: 't', link: '/x', readAt: null, createdAt: NOW_UTC,
    } as never);

    await setNotificationRead('n1', false);
    const call = vi.mocked(prisma.notification.update).mock.calls[0][0];
    expect(call?.data.readAt).toBeNull();
  });

  it('markAllNotificationsRead は user 自身の未読のみを既読化', async () => {
    vi.mocked(prisma.notification.updateMany).mockResolvedValue({ count: 5 } as never);
    const r = await markAllNotificationsRead('u-1');
    expect(r.count).toBe(5);
    const call = vi.mocked(prisma.notification.updateMany).mock.calls[0][0];
    expect(call?.where).toEqual({ userId: 'u-1', readAt: null });
  });
});

describe('generateDailyNotifications (cron)', () => {
  it('開始通知: type=activity AND status=not_started AND plannedStartDate=today (JST) で抽出', async () => {
    vi.mocked(prisma.task.findMany)
      .mockResolvedValueOnce([
        { id: 't1', name: 'Task A', projectId: 'p-1', assigneeId: 'u-1' },
      ] as never)
      .mockResolvedValueOnce([] as never);
    vi.mocked(prisma.notification.createMany).mockResolvedValue({ count: 1 } as never);

    const r = await generateDailyNotifications(NOW_UTC);

    const startCall = vi.mocked(prisma.task.findMany).mock.calls[0][0];
    expect(startCall?.where).toMatchObject({
      type: 'activity',
      deletedAt: null,
      status: 'not_started',
    });
    expect(r.startCreated).toBe(1);
  });

  it('終了通知: status≠completed AND plannedEndDate=today で抽出', async () => {
    vi.mocked(prisma.task.findMany)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([
        { id: 't2', name: 'Task B', projectId: 'p-1', assigneeId: 'u-2' },
      ] as never);
    vi.mocked(prisma.notification.createMany).mockResolvedValue({ count: 1 } as never);

    const r = await generateDailyNotifications(NOW_UTC);
    const endCall = vi.mocked(prisma.task.findMany).mock.calls[1][0];
    expect(endCall?.where).toMatchObject({
      type: 'activity',
      deletedAt: null,
      status: { not: 'completed' },
    });
    expect(r.endCreated).toBe(1);
  });

  it('createMany に skipDuplicates: true (DB UNIQUE 制約による dedupe)', async () => {
    vi.mocked(prisma.task.findMany)
      .mockResolvedValueOnce([
        { id: 't1', name: 'A', projectId: 'p-1', assigneeId: 'u-1' },
      ] as never)
      .mockResolvedValueOnce([] as never);
    vi.mocked(prisma.notification.createMany).mockResolvedValue({ count: 1 } as never);

    await generateDailyNotifications(NOW_UTC);
    const cmCall = vi.mocked(prisma.notification.createMany).mock.calls[0][0];
    expect(cmCall?.skipDuplicates).toBe(true);
    // dedupeKey 形式 (type:taskId:YYYY-MM-DD)
    expect((cmCall?.data as Array<{ dedupeKey: string }>)[0].dedupeKey).toBe('task_start_due:t1:2026-05-02');
  });

  it('対象 0 件なら createMany を呼ばない (空配列を弾く最適化)', async () => {
    vi.mocked(prisma.task.findMany).mockResolvedValue([] as never);
    const r = await generateDailyNotifications(NOW_UTC);
    expect(r.startCreated).toBe(0);
    expect(r.endCreated).toBe(0);
    expect(prisma.notification.createMany).not.toHaveBeenCalled();
  });
});

describe('cleanupReadNotifications', () => {
  it('既読 (readAt not null) かつ 30 日以上前を物理削除', async () => {
    vi.mocked(prisma.notification.deleteMany).mockResolvedValue({ count: 7 } as never);
    const r = await cleanupReadNotifications(NOW_UTC, 30);
    expect(r.deleted).toBe(7);
    const call = vi.mocked(prisma.notification.deleteMany).mock.calls[0][0];
    const cutoff = (call?.where as { readAt: { lt: Date; not: null } }).readAt;
    expect(cutoff.not).toBeNull();
    // 30 日前
    const expectedCutoff = new Date(NOW_UTC.getTime() - 30 * 24 * 60 * 60 * 1000);
    expect(cutoff.lt.getTime()).toBe(expectedCutoff.getTime());
  });

  it('retentionDays カスタマイズ (60 日)', async () => {
    vi.mocked(prisma.notification.deleteMany).mockResolvedValue({ count: 0 } as never);
    await cleanupReadNotifications(NOW_UTC, 60);
    const call = vi.mocked(prisma.notification.deleteMany).mock.calls[0][0];
    const cutoff = (call?.where as { readAt: { lt: Date } }).readAt.lt;
    const expected = new Date(NOW_UTC.getTime() - 60 * 24 * 60 * 60 * 1000);
    expect(cutoff.getTime()).toBe(expected.getTime());
  });
});
