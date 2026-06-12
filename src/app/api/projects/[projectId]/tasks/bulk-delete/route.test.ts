/**
 * ADR-0035: 一括削除 API のテスト。
 *
 * 検証観点:
 *   - task:delete 権限を要求する
 *   - 200 件超は 413 (DoS 安全弁)
 *   - バリデーション失敗 (空配列 / 非 UUID) は 400
 *   - 正常時は bulkDeleteTasks を呼び、削除 ID 群で recordBulkAuditLogs を記録
 *   - 越境等で 0 件削除時は監査ログを記録しない
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/auth', () => ({ auth: vi.fn() }));
vi.mock('@/lib/permissions', () => ({
  checkPermission: vi.fn(),
  checkMembership: vi.fn(),
}));
vi.mock('@/services/task.service', () => ({
  bulkDeleteTasks: vi.fn(),
}));
vi.mock('@/services/audit.service', () => ({
  recordBulkAuditLogs: vi.fn(),
}));
vi.mock('@/lib/db', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(async () => ({
        tokenVersion: 0,
        isActive: true,
        deletedAt: null,
      })),
    },
  },
}));

import { POST } from './route';
import { auth } from '@/lib/auth';
import { checkPermission, checkMembership } from '@/lib/permissions';
import { bulkDeleteTasks } from '@/services/task.service';
import { recordBulkAuditLogs } from '@/services/audit.service';

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';

function makeReq(body: unknown): Request {
  return new Request('http://test/api/projects/p-1/tasks/bulk-delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function makeParams() {
  return { params: Promise.resolve({ projectId: 'p-1' }) };
}

const pmUser = {
  user: { id: 'u-pm', name: 'PM', email: 'pm@x.co', systemRole: 'general', tenantId: 'tenant-1' },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth).mockResolvedValue(pmUser as never);
  vi.mocked(checkMembership).mockResolvedValue({
    isMember: true,
    projectRole: 'pm_tl',
    projectStatus: 'active',
  });
  vi.mocked(checkPermission).mockReturnValue({ allowed: true });
});

describe('POST /bulk-delete', () => {
  it('task:delete 権限を要求する', async () => {
    vi.mocked(bulkDeleteTasks).mockResolvedValue({ deletedCount: 1, deletedIds: [UUID_A] });

    const res = await POST(makeReq({ taskIds: [UUID_A] }) as never, makeParams() as never);

    expect(res.status).toBe(200);
    expect(checkPermission).toHaveBeenCalledWith('task:delete', expect.anything());
  });

  it('正常時: bulkDeleteTasks を呼び、削除 ID で監査ログを記録し deletedCount を返す', async () => {
    vi.mocked(bulkDeleteTasks).mockResolvedValue({
      deletedCount: 2,
      deletedIds: [UUID_A, UUID_B],
    });

    const res = await POST(
      makeReq({ taskIds: [UUID_A, UUID_B] }) as never,
      makeParams() as never,
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.deletedCount).toBe(2);
    expect(bulkDeleteTasks).toHaveBeenCalledWith('p-1', [UUID_A, UUID_B], 'u-pm', 'tenant-1');
    expect(recordBulkAuditLogs).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'DELETE',
        entityType: 'task',
        entityIds: [UUID_A, UUID_B],
      }),
    );
  });

  it('0 件削除時 (越境等) は監査ログを記録しない', async () => {
    vi.mocked(bulkDeleteTasks).mockResolvedValue({ deletedCount: 0, deletedIds: [] });

    const res = await POST(makeReq({ taskIds: [UUID_A] }) as never, makeParams() as never);

    expect(res.status).toBe(200);
    expect(recordBulkAuditLogs).not.toHaveBeenCalled();
  });

  it('200 件超は 413 (DoS 安全弁) で bulkDeleteTasks を呼ばない', async () => {
    // 201 件の有効 UUID を生成 (連番を 12 桁ゼロ詰めで末尾に埋め込む)
    const ids = Array.from({ length: 201 }, (_, i) =>
      `33333333-3333-4333-8333-${String(i).padStart(12, '0')}`,
    );

    const res = await POST(makeReq({ taskIds: ids }) as never, makeParams() as never);

    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.error.code).toBe('PAYLOAD_TOO_LARGE');
    expect(bulkDeleteTasks).not.toHaveBeenCalled();
  });

  it('空配列は 400 (バリデーション)', async () => {
    const res = await POST(makeReq({ taskIds: [] }) as never, makeParams() as never);
    expect(res.status).toBe(400);
    expect(bulkDeleteTasks).not.toHaveBeenCalled();
  });

  it('非 UUID は 400 (バリデーション)', async () => {
    const res = await POST(
      makeReq({ taskIds: ['not-a-uuid'] }) as never,
      makeParams() as never,
    );
    expect(res.status).toBe(400);
    expect(bulkDeleteTasks).not.toHaveBeenCalled();
  });
});
