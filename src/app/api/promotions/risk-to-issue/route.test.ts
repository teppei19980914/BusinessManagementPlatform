import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

vi.mock('@/lib/api-helpers', () => ({
  getAuthenticatedUser: vi.fn(),
  checkProjectPermission: vi.fn(),
  requireActualProjectMember: vi.fn(),
  requireStorageQuotaForWrite: vi.fn(async () => null),
}));
vi.mock('@/services/promotion.service', () => ({
  promoteRiskToIssue: vi.fn(),
}));
vi.mock('@/services/audit.service', () => ({
  recordAuditLog: vi.fn(),
  sanitizeForAudit: vi.fn((v: unknown) => v),
}));

import { POST } from './route';
import {
  getAuthenticatedUser,
  checkProjectPermission,
  requireActualProjectMember,
} from '@/lib/api-helpers';
import { promoteRiskToIssue } from '@/services/promotion.service';
import { recordAuditLog } from '@/services/audit.service';

const TENANT_ID = '00000000-0000-0000-0000-000000000001';
const RISK_ID = '00000000-0000-4000-8000-000000000001';
const PROJECT_ID = '00000000-0000-4000-8000-000000000002';

function postReq(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/promotions/risk-to-issue', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

const validBody = {
  riskId: RISK_ID,
  projectId: PROJECT_ID,
  input: { type: 'issue', title: '発生した課題' },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getAuthenticatedUser).mockResolvedValue({ id: 'u-1', tenantId: TENANT_ID, systemRole: 'general' } as never);
  vi.mocked(requireActualProjectMember).mockResolvedValue(null);
  vi.mocked(checkProjectPermission).mockResolvedValue(null);
});

describe('POST /api/promotions/risk-to-issue — 認可/検証', () => {
  it('未認証は 401', async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue(
      NextResponse.json({ error: 'UNAUTHENTICATED' }, { status: 401 }) as never,
    );
    const res = await POST(postReq(validBody));
    expect(res.status).toBe(401);
  });

  it('body 不正 (riskId が uuid でない) は 400', async () => {
    const res = await POST(postReq({ ...validBody, riskId: 'not-a-uuid' }));
    expect(res.status).toBe(400);
  });

  it('実プロジェクトメンバーでない場合はヘルパーの応答をそのまま返す', async () => {
    const forbidden = NextResponse.json({ error: { code: 'NOT_FOUND' } }, { status: 404 });
    vi.mocked(requireActualProjectMember).mockResolvedValue(forbidden);
    const res = await POST(postReq(validBody));
    expect(res.status).toBe(404);
    expect(promoteRiskToIssue).not.toHaveBeenCalled();
  });

  it('risk:create 権限が無い場合はヘルパーの応答をそのまま返す', async () => {
    const forbidden = NextResponse.json({ error: { code: 'FORBIDDEN' } }, { status: 403 });
    vi.mocked(checkProjectPermission).mockResolvedValue(forbidden);
    const res = await POST(postReq(validBody));
    expect(res.status).toBe(403);
  });
});

describe('POST /api/promotions/risk-to-issue — service エラーのマッピング', () => {
  it('NOT_FOUND → 404', async () => {
    vi.mocked(promoteRiskToIssue).mockRejectedValue(new Error('NOT_FOUND'));
    const res = await POST(postReq(validBody));
    expect(res.status).toBe(404);
  });

  it('INVALID_SOURCE_TYPE → 400', async () => {
    vi.mocked(promoteRiskToIssue).mockRejectedValue(new Error('INVALID_SOURCE_TYPE'));
    const res = await POST(postReq(validBody));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe('INVALID_SOURCE_TYPE');
  });

  it('SOURCE_NOT_PUBLIC → 400', async () => {
    vi.mocked(promoteRiskToIssue).mockRejectedValue(new Error('SOURCE_NOT_PUBLIC'));
    const res = await POST(postReq(validBody));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe('SOURCE_NOT_PUBLIC');
  });

  it('ASSIGNEE_TENANT_MISMATCH → 400', async () => {
    vi.mocked(promoteRiskToIssue).mockRejectedValue(new Error('ASSIGNEE_TENANT_MISMATCH'));
    const res = await POST(postReq(validBody));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe('ASSIGNEE_TENANT_MISMATCH');
  });

  it('想定外のエラーは re-throw される', async () => {
    vi.mocked(promoteRiskToIssue).mockRejectedValue(new Error('UNEXPECTED'));
    await expect(POST(postReq(validBody))).rejects.toThrow('UNEXPECTED');
  });
});

describe('POST /api/promotions/risk-to-issue — 成功', () => {
  it('201 + 新規 issue を返し、audit log を記録する', async () => {
    const newIssue = { id: 'i-new', title: '発生した課題', visibility: 'public' };
    vi.mocked(promoteRiskToIssue).mockResolvedValue(newIssue as never);

    const res = await POST(postReq(validBody));

    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.data).toEqual(newIssue);
    // zod の createRiskSchema は parse 時に default (content/impact/visibility 等) を補完するため、
    // 送信した部分集合ではなく補完後の値で比較する。
    expect(promoteRiskToIssue).toHaveBeenCalledWith(RISK_ID, PROJECT_ID, {
      ...validBody.input,
      content: '',
      impact: 'medium',
      visibility: 'draft',
    }, 'u-1', TENANT_ID);
    expect(recordAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT_ID,
      userId: 'u-1',
      action: 'CREATE',
      entityType: 'risk_issue',
      entityId: 'i-new',
    }));
  });
});
