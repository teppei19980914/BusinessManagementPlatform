/**
 * sample-curation.service の単体テスト (feat/starter-data-import / 2026-06-05)
 *
 * 最重要 (severity-1): isSampleData の切替は **管理テナント (MANAGEMENT_TENANT_ID) の行に限定** される
 *   = updateMany の where に tenant_id が含まれること。これが崩れると他テナントの実データを
 *     サンプル化して全テナントの取込対象に漏洩させる事故になる。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  prisma: {
    project: { findMany: vi.fn(), updateMany: vi.fn() },
    knowledge: { findMany: vi.fn(), updateMany: vi.fn() },
  },
}));

vi.mock('@/lib/tenant', () => ({
  MANAGEMENT_TENANT_ID: '00000000-0000-0000-0000-ffffffffffff',
}));

import {
  listManagementSeedCandidates,
  setManagementSampleFlag,
} from './sample-curation.service';
import { prisma } from '@/lib/db';

const MGMT = '00000000-0000-0000-0000-ffffffffffff';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('listManagementSeedCandidates', () => {
  it('管理テナントの project + knowledge を統合して返す', async () => {
    vi.mocked(prisma.project.findMany).mockResolvedValue([
      { id: 'p1', name: 'PJ1', isSampleData: true },
    ] as never);
    vi.mocked(prisma.knowledge.findMany).mockResolvedValue([
      { id: 'k1', title: 'KW1', isSampleData: false },
    ] as never);

    const r = await listManagementSeedCandidates();
    expect(r).toEqual([
      { id: 'p1', type: 'project', title: 'PJ1', isSampleData: true },
      { id: 'k1', type: 'knowledge', title: 'KW1', isSampleData: false },
    ]);
    // 読み出しも管理テナントに限定
    expect(prisma.project.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ tenantId: MGMT }) }),
    );
  });
});

describe('setManagementSampleFlag (severity-1: 管理テナント限定)', () => {
  it('project: updateMany の where に tenantId=MANAGEMENT_TENANT_ID を含める', async () => {
    vi.mocked(prisma.project.updateMany).mockResolvedValue({ count: 1 } as never);
    const r = await setManagementSampleFlag({ entityType: 'project', entityId: 'p1', isSampleData: true });
    expect(r.ok).toBe(true);
    expect(prisma.project.updateMany).toHaveBeenCalledWith({
      where: { id: 'p1', tenantId: MGMT, deletedAt: null },
      data: { isSampleData: true },
    });
  });

  it('knowledge: updateMany の where に tenantId=MANAGEMENT_TENANT_ID を含める', async () => {
    vi.mocked(prisma.knowledge.updateMany).mockResolvedValue({ count: 1 } as never);
    const r = await setManagementSampleFlag({ entityType: 'knowledge', entityId: 'k1', isSampleData: false });
    expect(r.ok).toBe(true);
    expect(prisma.knowledge.updateMany).toHaveBeenCalledWith({
      where: { id: 'k1', tenantId: MGMT, deletedAt: null },
      data: { isSampleData: false },
    });
  });

  it('管理テナント外 (count=0) なら NOT_FOUND = 越境した id は更新されない', async () => {
    vi.mocked(prisma.project.updateMany).mockResolvedValue({ count: 0 } as never);
    const r = await setManagementSampleFlag({ entityType: 'project', entityId: 'other-tenant-pj', isSampleData: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('NOT_FOUND');
  });
});
