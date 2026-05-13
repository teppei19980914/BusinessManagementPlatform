import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  prisma: {
    notification: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      // 2026-05-09 feedback Phase 2-7: setNotificationRead / getNotification は所有確認に findFirst を使う
      findFirst: vi.fn(),
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

    const r = await listNotificationsForUser('u-1', 'tenant-A');
    expect(r.unreadCount).toBe(3);
    expect(r.items).toHaveLength(1);
    const findCall = vi.mocked(prisma.notification.findMany).mock.calls[0][0];
    expect(findCall?.where).toEqual({ userId: 'u-1', tenantId: 'tenant-A', readAt: null });
  });

  it('includeRead=true で既読も含める', async () => {
    vi.mocked(prisma.notification.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.notification.count).mockResolvedValue(0 as never);

    await listNotificationsForUser('u-1', 'tenant-A', { includeRead: true });
    const findCall = vi.mocked(prisma.notification.findMany).mock.calls[0][0];
    expect(findCall?.where).toEqual({ userId: 'u-1', tenantId: 'tenant-A' });
  });
});

describe('setNotificationRead / markAllNotificationsRead', () => {
  it('setNotificationRead(true) は readAt をセット', async () => {
    // 2026-05-09 feedback Phase 2-7: 所有確認 mock 必須
    vi.mocked(prisma.notification.findFirst).mockResolvedValue({ id: 'n1' } as never);
    vi.mocked(prisma.notification.update).mockResolvedValue({
      id: 'n1', type: 'task_start_due', entityType: 'task', entityId: 't1',
      title: 't', link: '/x', readAt: NOW_UTC, createdAt: NOW_UTC,
    } as never);

    const r = await setNotificationRead('n1', true, 'u-1', 'tenant-A');
    expect(r.readAt).not.toBeNull();
    const call = vi.mocked(prisma.notification.update).mock.calls[0][0];
    expect(call?.data.readAt).toBeInstanceOf(Date);
  });

  it('setNotificationRead(false) は readAt を null にする', async () => {
    vi.mocked(prisma.notification.findFirst).mockResolvedValue({ id: 'n1' } as never);
    vi.mocked(prisma.notification.update).mockResolvedValue({
      id: 'n1', type: 'task_start_due', entityType: 'task', entityId: 't1',
      title: 't', link: '/x', readAt: null, createdAt: NOW_UTC,
    } as never);

    await setNotificationRead('n1', false, 'u-1', 'tenant-A');
    const call = vi.mocked(prisma.notification.update).mock.calls[0][0];
    expect(call?.data.readAt).toBeNull();
  });

  it('markAllNotificationsRead は user 自身の未読のみを既読化', async () => {
    vi.mocked(prisma.notification.updateMany).mockResolvedValue({ count: 5 } as never);
    const r = await markAllNotificationsRead('u-1', 'tenant-A');
    expect(r.count).toBe(5);
    const call = vi.mocked(prisma.notification.updateMany).mock.calls[0][0];
    expect(call?.where).toEqual({ userId: 'u-1', tenantId: 'tenant-A', readAt: null });
  });
});

describe('generateDailyNotifications (cron)', () => {
  it('開始通知: type=activity AND status=not_started AND plannedStartDate=today (JST) で抽出', async () => {
    vi.mocked(prisma.task.findMany)
      .mockResolvedValueOnce([
        { id: 't1', name: 'Task A', projectId: 'p-1', assigneeId: 'u-1', project: { tenantId: 'tenant-A' } },
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
    // 2026-05-13 (fix/notification-tenant-isolation): project.tenantId を select で同時取得
    expect(startCall?.select).toMatchObject({
      project: { select: { tenantId: true } },
    });
    expect(r.startCreated).toBe(1);
  });

  it('終了通知: status≠completed AND plannedEndDate=today で抽出', async () => {
    vi.mocked(prisma.task.findMany)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([
        { id: 't2', name: 'Task B', projectId: 'p-1', assigneeId: 'u-2', project: { tenantId: 'tenant-A' } },
      ] as never);
    vi.mocked(prisma.notification.createMany).mockResolvedValue({ count: 1 } as never);

    const r = await generateDailyNotifications(NOW_UTC);
    const endCall = vi.mocked(prisma.task.findMany).mock.calls[1][0];
    expect(endCall?.where).toMatchObject({
      type: 'activity',
      deletedAt: null,
      status: { not: 'completed' },
    });
    // 2026-05-13 (fix/notification-tenant-isolation): project.tenantId を select で同時取得
    expect(endCall?.select).toMatchObject({
      project: { select: { tenantId: true } },
    });
    expect(r.endCreated).toBe(1);
  });

  it('createMany に skipDuplicates: true (DB UNIQUE 制約による dedupe)', async () => {
    vi.mocked(prisma.task.findMany)
      .mockResolvedValueOnce([
        { id: 't1', name: 'A', projectId: 'p-1', assigneeId: 'u-1', project: { tenantId: 'tenant-A' } },
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

  // 2026-05-13 (fix/notification-tenant-isolation): severity-1 テナント越境防止の回帰テスト。
  //   cron が複数テナントの task を一度に処理する状況で、各 Notification.tenantId が
  //   親 task の project.tenantId と一致する事を保証する。
  //   退行例: createMany.data に tenantId を渡し忘れると schema の DB DEFAULT
  //   (default-tenant UUID) に落ち、テナント A のユーザが listNotificationsForUser
  //   (where.tenantId フィルタ) で自分の通知を見られなくなる機能不全になる。
  it('複数テナント混在時、Notification.tenantId が親 task.project.tenantId と一致する (severity-1 回帰テスト)', async () => {
    vi.mocked(prisma.task.findMany)
      .mockResolvedValueOnce([
        { id: 't-A1', name: 'A1', projectId: 'p-A', assigneeId: 'u-A1', project: { tenantId: 'tenant-A' } },
        { id: 't-B1', name: 'B1', projectId: 'p-B', assigneeId: 'u-B1', project: { tenantId: 'tenant-B' } },
      ] as never)
      .mockResolvedValueOnce([
        { id: 't-A2', name: 'A2', projectId: 'p-A', assigneeId: 'u-A2', project: { tenantId: 'tenant-A' } },
        { id: 't-C1', name: 'C1', projectId: 'p-C', assigneeId: 'u-C1', project: { tenantId: 'tenant-C' } },
      ] as never);
    vi.mocked(prisma.notification.createMany)
      .mockResolvedValueOnce({ count: 2 } as never)
      .mockResolvedValueOnce({ count: 2 } as never);

    await generateDailyNotifications(NOW_UTC);

    // 開始通知側
    const startCm = vi.mocked(prisma.notification.createMany).mock.calls[0][0];
    const startData = startCm?.data as Array<{ tenantId: string; entityId: string }>;
    expect(startData).toHaveLength(2);
    expect(startData.find((d) => d.entityId === 't-A1')?.tenantId).toBe('tenant-A');
    expect(startData.find((d) => d.entityId === 't-B1')?.tenantId).toBe('tenant-B');

    // 終了通知側
    const endCm = vi.mocked(prisma.notification.createMany).mock.calls[1][0];
    const endData = endCm?.data as Array<{ tenantId: string; entityId: string }>;
    expect(endData).toHaveLength(2);
    expect(endData.find((d) => d.entityId === 't-A2')?.tenantId).toBe('tenant-A');
    expect(endData.find((d) => d.entityId === 't-C1')?.tenantId).toBe('tenant-C');

    // schema DB DEFAULT (default-tenant) に依存していない事を再確認:
    // 全 data の tenantId は親 task.project.tenantId 由来であり、default-tenant UUID は出現しない。
    const allTenantIds = [...startData, ...endData].map((d) => d.tenantId);
    expect(allTenantIds).not.toContain('00000000-0000-0000-0000-000000000001');
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
