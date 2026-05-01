import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildEntityCommentLink } from './entity-link';
import { prisma } from './db';

vi.mock('./db', () => ({
  prisma: {
    task: { findFirst: vi.fn() },
    riskIssue: { findFirst: vi.fn() },
    retrospective: { findFirst: vi.fn() },
    knowledge: { findFirst: vi.fn() },
    stakeholder: { findFirst: vi.fn() },
    customer: { findFirst: vi.fn() },
  },
}));

describe('buildEntityCommentLink', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('cross-list (mention 受信者が project member 以外でもアクセス可)', () => {
    it('risk: /risks?riskId=... に遷移 (全リスク画面で auto-open)', async () => {
      vi.mocked(prisma.riskIssue.findFirst).mockResolvedValue({ type: 'risk' } as never);
      const link = await buildEntityCommentLink('risk', 'r-1');
      expect(link).toBe('/risks?riskId=r-1');
    });

    it('issue: /issues?riskId=... に遷移 (全課題画面で auto-open)', async () => {
      vi.mocked(prisma.riskIssue.findFirst).mockResolvedValue({ type: 'issue' } as never);
      const link = await buildEntityCommentLink('issue', 'i-1');
      expect(link).toBe('/issues?riskId=i-1');
    });

    it('retrospective: /retrospectives?retroId=... に遷移', async () => {
      vi.mocked(prisma.retrospective.findFirst).mockResolvedValue({ id: 'r-1' } as never);
      const link = await buildEntityCommentLink('retrospective', 'r-1');
      expect(link).toBe('/retrospectives?retroId=r-1');
    });

    it('knowledge: /knowledge?knowledgeId=... に遷移', async () => {
      vi.mocked(prisma.knowledge.findFirst).mockResolvedValue({ id: 'k-1' } as never);
      const link = await buildEntityCommentLink('knowledge', 'k-1');
      expect(link).toBe('/knowledge?knowledgeId=k-1');
    });

    it('risk が削除済なら fallback /risks (query 無し)', async () => {
      vi.mocked(prisma.riskIssue.findFirst).mockResolvedValue(null);
      const link = await buildEntityCommentLink('risk', 'deleted-1');
      expect(link).toBe('/risks');
    });

    it('issue が削除済なら fallback /issues', async () => {
      vi.mocked(prisma.riskIssue.findFirst).mockResolvedValue(null);
      const link = await buildEntityCommentLink('issue', 'deleted-1');
      expect(link).toBe('/issues');
    });
  });

  describe('project-scoped (mention 認可で受信者の権限を担保済)', () => {
    it('task: /projects/[id]/tasks?taskId=... (ProjectMember のみメンション可)', async () => {
      vi.mocked(prisma.task.findFirst).mockResolvedValue({ projectId: 'p-1' } as never);
      const link = await buildEntityCommentLink('task', 't-1');
      expect(link).toBe('/projects/p-1/tasks?taskId=t-1');
    });

    it('stakeholder: /projects/[id]/stakeholders?stakeholderId=... (PM/TL のみメンション可)', async () => {
      vi.mocked(prisma.stakeholder.findFirst).mockResolvedValue({ projectId: 'p-1' } as never);
      const link = await buildEntityCommentLink('stakeholder', 's-1');
      expect(link).toBe('/projects/p-1/stakeholders?stakeholderId=s-1');
    });

    it('task が削除済なら fallback /my-tasks', async () => {
      vi.mocked(prisma.task.findFirst).mockResolvedValue(null);
      const link = await buildEntityCommentLink('task', 'deleted-1');
      expect(link).toBe('/my-tasks');
    });

    it('stakeholder が削除済なら fallback /projects', async () => {
      vi.mocked(prisma.stakeholder.findFirst).mockResolvedValue(null);
      const link = await buildEntityCommentLink('stakeholder', 'deleted-1');
      expect(link).toBe('/projects');
    });
  });

  describe('admin only', () => {
    it('customer: /customers/[id] に直接遷移 (admin only ページ)', async () => {
      const link = await buildEntityCommentLink('customer', 'c-1');
      expect(link).toBe('/customers/c-1');
    });
  });
});
