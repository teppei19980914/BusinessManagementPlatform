import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/db', () => ({
  prisma: {
    notification: {
      // 2026-05-10 Phase 2-7: getNotification / setNotificationRead は越境遮断のため
      //   findFirst (tenantId フィルタ付き) を使う。所有確認 (setNotificationRead) も findFirst。
      findFirst: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock('@/lib/api-helpers', () => ({
  getAuthenticatedUser: vi.fn(),
}));

vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn(async () => (k: string) => k),
}));

import { PATCH } from './route';
import { prisma } from '@/lib/db';
import { getAuthenticatedUser } from '@/lib/api-helpers';

const NOTIF_ID = 'n-1';
const params = Promise.resolve({ id: NOTIF_ID });

function patchReq(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/notifications/n-1', {
    method: 'PATCH',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.notification.update).mockResolvedValue({
    id: NOTIF_ID, type: 'task_end_due', entityType: 'task', entityId: 't-1',
    title: 't', link: '/x', readAt: new Date(), createdAt: new Date(),
  } as never);
});

describe('PATCH /api/notifications/[id]', () => {
  it('自分の通知を read=true で既読化できる', async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue({ id: 'u-1', systemRole: 'general', tenantId: 'tenant-A' } as never);
    // 2026-05-10 Phase 2-7: getNotification の所有判定 + setNotificationRead の所有確認とも findFirst
    vi.mocked(prisma.notification.findFirst).mockResolvedValue({ id: NOTIF_ID, userId: 'u-1' } as never);

    const res = await PATCH(patchReq({ read: true }), { params });
    expect(res.status).toBe(200);
  });

  it('他人の通知は 403 (CWE-639 IDOR 対策)', async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue({ id: 'u-other', systemRole: 'general', tenantId: 'tenant-A' } as never);
    vi.mocked(prisma.notification.findFirst).mockResolvedValue({ id: NOTIF_ID, userId: 'u-1' } as never);

    const res = await PATCH(patchReq({ read: true }), { params });
    expect(res.status).toBe(403);
  });

  it('admin でも他人の通知は 403 (本人の通知のみ操作可)', async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue({ id: 'u-admin', systemRole: 'admin', tenantId: 'tenant-A' } as never);
    vi.mocked(prisma.notification.findFirst).mockResolvedValue({ id: NOTIF_ID, userId: 'u-1' } as never);

    const res = await PATCH(patchReq({ read: true }), { params });
    expect(res.status).toBe(403);
  });

  it('存在しない通知は 404', async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue({ id: 'u-1', systemRole: 'general', tenantId: 'tenant-A' } as never);
    vi.mocked(prisma.notification.findFirst).mockResolvedValue(null);

    const res = await PATCH(patchReq({ read: true }), { params });
    expect(res.status).toBe(404);
  });

  it('body の read が boolean でなければ 400', async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue({ id: 'u-1', systemRole: 'general', tenantId: 'tenant-A' } as never);
    vi.mocked(prisma.notification.findFirst).mockResolvedValue({ id: NOTIF_ID, userId: 'u-1' } as never);

    const res = await PATCH(patchReq({ read: 'yes' }), { params });
    expect(res.status).toBe(400);
  });
});
