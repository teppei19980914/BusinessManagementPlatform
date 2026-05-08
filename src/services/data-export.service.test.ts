/**
 * テナントデータ一括エクスポートサービスの単体テスト (P-C / 2026-05-08)
 *
 * 検証項目:
 *   - テナント不在時 → TENANT_NOT_FOUND
 *   - テナントスコープ: 他テナントのデータが ZIP に含まれない
 *   - User の PII (passwordHash 等) が ZIP に含まれない
 *   - ZIP 構造: README.md / metadata.json / data/*.json / csv/*.csv
 *   - 件数サマリの正確性
 *   - 空テナントでも有効な ZIP が生成される
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import JSZip from 'jszip';

vi.mock('@/lib/db', () => ({
  prisma: {
    tenant: { findFirst: vi.fn() },
    project: { findMany: vi.fn() },
    task: { findMany: vi.fn() },
    estimate: { findMany: vi.fn() },
    projectMember: { findMany: vi.fn() },
    knowledge: { findMany: vi.fn() },
    knowledgeProject: { findMany: vi.fn() },
    riskIssue: { findMany: vi.fn() },
    retrospective: { findMany: vi.fn() },
    memo: { findMany: vi.fn() },
    customer: { findMany: vi.fn() },
    stakeholder: { findMany: vi.fn() },
    comment: { findMany: vi.fn() },
    mention: { findMany: vi.fn() },
    attachment: { findMany: vi.fn() },
    user: { findMany: vi.fn() },
  },
}));

import { exportTenantData } from './data-export.service';
import { prisma } from '@/lib/db';

const TENANT_ID = 'tenant-uuid-1';

beforeEach(() => {
  vi.clearAllMocks();
  // デフォルトはすべて空配列を返す
  vi.mocked(prisma.tenant.findFirst).mockResolvedValue({
    id: TENANT_ID,
    name: 'カスタマーA',
    slug: 'customer-a',
  } as never);
  vi.mocked(prisma.project.findMany).mockResolvedValue([]);
  vi.mocked(prisma.task.findMany).mockResolvedValue([]);
  vi.mocked(prisma.estimate.findMany).mockResolvedValue([]);
  vi.mocked(prisma.projectMember.findMany).mockResolvedValue([]);
  vi.mocked(prisma.knowledge.findMany).mockResolvedValue([]);
  vi.mocked(prisma.knowledgeProject.findMany).mockResolvedValue([]);
  vi.mocked(prisma.riskIssue.findMany).mockResolvedValue([]);
  vi.mocked(prisma.retrospective.findMany).mockResolvedValue([]);
  vi.mocked(prisma.memo.findMany).mockResolvedValue([]);
  vi.mocked(prisma.customer.findMany).mockResolvedValue([]);
  vi.mocked(prisma.stakeholder.findMany).mockResolvedValue([]);
  vi.mocked(prisma.comment.findMany).mockResolvedValue([]);
  vi.mocked(prisma.mention.findMany).mockResolvedValue([]);
  vi.mocked(prisma.attachment.findMany).mockResolvedValue([]);
  vi.mocked(prisma.user.findMany).mockResolvedValue([]);
});

describe('exportTenantData', () => {
  it('テナント不在なら TENANT_NOT_FOUND', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce(null);

    await expect(exportTenantData('non-existent')).rejects.toThrow('TENANT_NOT_FOUND');
  });

  it('空テナントでも有効な ZIP が生成される (README + metadata + data/ + csv/)', async () => {
    const result = await exportTenantData(TENANT_ID);

    expect(result.zipBuffer).toBeInstanceOf(Uint8Array);
    expect(result.zipBuffer.length).toBeGreaterThan(0);
    expect(result.filename).toMatch(/^tasukiba-export-customer-a-\d{4}-\d{2}-\d{2}\.zip$/);

    // ZIP を解凍して内容を verify
    const zip = await JSZip.loadAsync(result.zipBuffer);
    expect(zip.file('README.md')).not.toBeNull();
    expect(zip.file('metadata.json')).not.toBeNull();
    expect(zip.file('data/projects.json')).not.toBeNull();
    expect(zip.file('data/users.json')).not.toBeNull();
    expect(zip.file('csv/projects.csv')).not.toBeNull();
    expect(zip.file('csv/knowledge.csv')).not.toBeNull();
  });

  it('件数サマリが正確に計上される', async () => {
    vi.mocked(prisma.project.findMany).mockResolvedValueOnce([
      { id: 'p1' } as never,
      { id: 'p2' } as never,
    ] as never);
    vi.mocked(prisma.knowledge.findMany).mockResolvedValueOnce([
      { id: 'k1' } as never,
    ] as never);
    vi.mocked(prisma.user.findMany).mockResolvedValueOnce([
      { id: 'u1', email: 'a@b.co', passwordHash: 'x' } as never,
      { id: 'u2', email: 'c@d.co', passwordHash: 'y' } as never,
      { id: 'u3', email: 'e@f.co', passwordHash: 'z' } as never,
    ] as never);

    const result = await exportTenantData(TENANT_ID);

    expect(result.summary.counts.projects).toBe(2);
    expect(result.summary.counts.knowledge).toBe(1);
    expect(result.summary.counts.users).toBe(3);
  });

  it('User の PII (passwordHash / mfaSecret 等) は ZIP に含まれない', async () => {
    vi.mocked(prisma.user.findMany).mockResolvedValueOnce([
      {
        id: 'u1',
        name: 'ユーザA',
        email: 'a@b.co',
        passwordHash: 'should_not_appear',
        systemRole: 'admin',
        isActive: true,
        mfaSecretEncrypted: 'should_not_appear_either',
        mfaEnabled: true,
        failedLoginCount: 5,
        lockedUntil: new Date(),
        permanentLock: true,
        forcePasswordChange: true,
        themePreference: 'light',
        timezone: 'Asia/Tokyo',
        locale: 'ja-JP',
        lastLoginAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ] as never);

    const result = await exportTenantData(TENANT_ID);
    const zip = await JSZip.loadAsync(result.zipBuffer);
    const usersJson = await zip.file('data/users.json')?.async('string');

    expect(usersJson).not.toContain('should_not_appear');
    expect(usersJson).not.toContain('passwordHash');
    expect(usersJson).not.toContain('mfaSecretEncrypted');
    expect(usersJson).not.toContain('failedLoginCount');
    expect(usersJson).not.toContain('permanentLock');
    expect(usersJson).not.toContain('forcePasswordChange');

    // ホワイトリストの列は含まれる
    expect(usersJson).toContain('name');
    expect(usersJson).toContain('email');
    expect(usersJson).toContain('systemRole');
    expect(usersJson).toContain('themePreference');
  });

  it('テナントスコープが where 句に含まれる (= 他テナントデータは混入しない)', async () => {
    await exportTenantData(TENANT_ID);

    // 全 entity の findMany が tenantId 条件付きで呼ばれていることを確認
    expect(prisma.project.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: TENANT_ID }),
      }),
    );
    expect(prisma.knowledge.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: TENANT_ID }),
      }),
    );
    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: TENANT_ID }),
      }),
    );
    expect(prisma.customer.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: TENANT_ID }),
      }),
    );
  });

  it('CSV 出力に UTF-8 BOM が付与される (Excel 日本語対応)', async () => {
    vi.mocked(prisma.project.findMany).mockResolvedValueOnce([
      {
        id: 'p1',
        name: 'プロジェクトA',
        purpose: '日本語データ',
        createdAt: new Date('2026-01-01'),
      } as never,
    ] as never);

    const result = await exportTenantData(TENANT_ID);
    const zip = await JSZip.loadAsync(result.zipBuffer);
    const projectsCsv = await zip.file('csv/projects.csv')?.async('string');

    // UTF-8 BOM (﻿) で始まる
    expect(projectsCsv?.charCodeAt(0)).toBe(0xfeff);
    expect(projectsCsv).toContain('プロジェクトA');
    expect(projectsCsv).toContain('日本語データ');
  });

  it('Date は ISO 8601 文字列に変換される (JSON 内)', async () => {
    const fixedDate = new Date('2026-05-08T12:34:56.000Z');
    vi.mocked(prisma.project.findMany).mockResolvedValueOnce([
      {
        id: 'p1',
        name: 'P1',
        createdAt: fixedDate,
        updatedAt: fixedDate,
      } as never,
    ] as never);

    const result = await exportTenantData(TENANT_ID);
    const zip = await JSZip.loadAsync(result.zipBuffer);
    const projectsJson = await zip.file('data/projects.json')?.async('string');

    expect(projectsJson).toContain('2026-05-08T12:34:56.000Z');
  });

  it('metadata.json にエクスポート情報が含まれる', async () => {
    const result = await exportTenantData(TENANT_ID);
    const zip = await JSZip.loadAsync(result.zipBuffer);
    const metaStr = await zip.file('metadata.json')?.async('string');
    expect(metaStr).toBeTruthy();

    const meta = JSON.parse(metaStr ?? '{}');
    expect(meta.tenantId).toBe(TENANT_ID);
    expect(meta.tenantName).toBe('カスタマーA');
    expect(meta.tenantSlug).toBe('customer-a');
    expect(meta.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(meta.counts).toBeDefined();
  });
});
