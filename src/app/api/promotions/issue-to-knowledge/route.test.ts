import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

vi.mock('@/lib/api-helpers', () => ({
  getAuthenticatedUser: vi.fn(),
  requireStorageQuotaForWrite: vi.fn(async () => null),
}));
vi.mock('@/lib/db', () => ({
  prisma: {
    projectMember: { findMany: vi.fn() },
  },
}));
vi.mock('@/services/promotion.service', () => ({
  promoteIssueToKnowledge: vi.fn(),
}));
vi.mock('@/services/audit.service', () => ({
  recordAuditLog: vi.fn(),
  sanitizeForAudit: vi.fn((v: unknown) => v),
}));
vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn(async () => (k: string) => k),
}));

import { POST } from './route';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { prisma } from '@/lib/db';
import { promoteIssueToKnowledge } from '@/services/promotion.service';
import { recordAuditLog } from '@/services/audit.service';

const TENANT_ID = '00000000-0000-0000-0000-000000000001';
const ISSUE_ID = '00000000-0000-4000-8000-000000000001';
const PROJECT_ID = '00000000-0000-4000-8000-000000000002';

function postReq(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/promotions/issue-to-knowledge', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

const validBody = {
  issueId: ISSUE_ID,
  input: { title: '得られたナレッジ' },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getAuthenticatedUser).mockResolvedValue({ id: 'u-1', tenantId: TENANT_ID, systemRole: 'general' } as never);
});

describe('POST /api/promotions/issue-to-knowledge — 認可/検証', () => {
  it('未認証は 401', async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue(
      NextResponse.json({ error: 'UNAUTHENTICATED' }, { status: 401 }) as never,
    );
    const res = await POST(postReq(validBody));
    expect(res.status).toBe(401);
  });

  it('body 不正 (issueId が uuid でない) は 400', async () => {
    const res = await POST(postReq({ ...validBody, issueId: 'not-a-uuid' }));
    expect(res.status).toBe(400);
  });

  it('projectIds 指定時、非メンバーの project が含まれると 403', async () => {
    vi.mocked(prisma.projectMember.findMany).mockResolvedValue([] as never);
    const res = await POST(postReq({ ...validBody, input: { ...validBody.input, projectIds: [PROJECT_ID] } }));
    expect(res.status).toBe(403);
    expect(promoteIssueToKnowledge).not.toHaveBeenCalled();
  });

  it('projectIds 指定時、全て実メンバーなら通過する', async () => {
    vi.mocked(prisma.projectMember.findMany).mockResolvedValue([{ projectId: PROJECT_ID }] as never);
    vi.mocked(promoteIssueToKnowledge).mockResolvedValue({ id: 'k-1', title: 'x', visibility: 'draft' } as never);
    const res = await POST(postReq({ ...validBody, input: { ...validBody.input, projectIds: [PROJECT_ID] } }));
    expect(res.status).toBe(201);
  });

  it('projectIds 未指定時は projectMember を問い合わせない', async () => {
    vi.mocked(promoteIssueToKnowledge).mockResolvedValue({ id: 'k-1', title: 'x', visibility: 'draft' } as never);
    await POST(postReq(validBody));
    expect(prisma.projectMember.findMany).not.toHaveBeenCalled();
  });
});

describe('POST /api/promotions/issue-to-knowledge — service エラーのマッピング', () => {
  it('NOT_FOUND → 404', async () => {
    vi.mocked(promoteIssueToKnowledge).mockRejectedValue(new Error('NOT_FOUND'));
    const res = await POST(postReq(validBody));
    expect(res.status).toBe(404);
  });

  it('INVALID_SOURCE_TYPE → 400', async () => {
    vi.mocked(promoteIssueToKnowledge).mockRejectedValue(new Error('INVALID_SOURCE_TYPE'));
    const res = await POST(postReq(validBody));
    expect(res.status).toBe(400);
  });

  it('SOURCE_NOT_PUBLIC → 400', async () => {
    vi.mocked(promoteIssueToKnowledge).mockRejectedValue(new Error('SOURCE_NOT_PUBLIC'));
    const res = await POST(postReq(validBody));
    expect(res.status).toBe(400);
  });

  it('想定外のエラーは re-throw される', async () => {
    vi.mocked(promoteIssueToKnowledge).mockRejectedValue(new Error('UNEXPECTED'));
    await expect(POST(postReq(validBody))).rejects.toThrow('UNEXPECTED');
  });
});

describe('POST /api/promotions/issue-to-knowledge — 成功', () => {
  it('201 + 新規ナレッジを返し、audit log を記録する', async () => {
    const newKnowledge = { id: 'k-new', title: '得られたナレッジ', visibility: 'draft' };
    vi.mocked(promoteIssueToKnowledge).mockResolvedValue(newKnowledge as never);

    const res = await POST(postReq(validBody));

    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.data).toEqual(newKnowledge);
    // zod の createKnowledgeSchema は parse 時に default (background/content/result 等) を
    // 補完するため、送信した部分集合ではなく補完後の値で比較する。
    expect(promoteIssueToKnowledge).toHaveBeenCalledWith(ISSUE_ID, {
      ...validBody.input,
      knowledgeType: 'other',
      background: '',
      content: '',
      result: '',
      visibility: 'draft',
    }, 'u-1', TENANT_ID);
    expect(recordAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT_ID,
      userId: 'u-1',
      action: 'CREATE',
      entityType: 'knowledge',
      entityId: 'k-new',
    }));
  });
});
