import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/api-helpers', () => ({
  getAuthenticatedUser: vi.fn(),
  checkProjectPermission: vi.fn(),
  requireActualProjectMember: vi.fn(),
}));

vi.mock('@/services/idea-asset-link.service', () => ({
  getIdeaAssetLinks: vi.fn(),
  getIdeaAssetLinksByTarget: vi.fn(),
  createIdeaAssetLink: vi.fn(),
  deleteIdeaAssetLink: vi.fn(),
}));

vi.mock('@/services/audit.service', () => ({
  recordAuditLog: vi.fn(),
}));

import { GET, POST, DELETE } from './route';
import { NextResponse } from 'next/server';
import { getAuthenticatedUser, checkProjectPermission, requireActualProjectMember } from '@/lib/api-helpers';
import {
  getIdeaAssetLinks,
  getIdeaAssetLinksByTarget,
  createIdeaAssetLink,
  deleteIdeaAssetLink,
} from '@/services/idea-asset-link.service';

const mockedGetAuth = vi.mocked(getAuthenticatedUser);
const mockedCheckPerm = vi.mocked(checkProjectPermission);
const mockedRequireMember = vi.mocked(requireActualProjectMember);
const mockedGetLinks = vi.mocked(getIdeaAssetLinks);
const mockedGetByTarget = vi.mocked(getIdeaAssetLinksByTarget);
const mockedCreate = vi.mocked(createIdeaAssetLink);
const mockedDelete = vi.mocked(deleteIdeaAssetLink);

const VALID_USER = {
  id: '00000000-0000-0000-0000-000000000010',
  tenantId: '00000000-0000-0000-0000-000000000001',
  name: 'Tester',
  email: 't@example.com',
  systemRole: 'general' as const,
};

const SRC_ID = '550e8400-e29b-41d4-a716-446655440010';
const TGT_ID = '550e8400-e29b-41d4-a716-446655440020';
const LINK_ID = '550e8400-e29b-41d4-a716-446655440030';

function mockParams(projectId: string) {
  return { params: Promise.resolve({ projectId }) };
}

const LINK_DTO = {
  id: LINK_ID,
  sourceType: 'voting_session',
  sourceId: SRC_ID,
  targetType: 'task',
  targetId: TGT_ID,
  createdBy: VALID_USER.id,
  createdAt: new Date().toISOString(),
  targetTitle: 'タスク名',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockedGetAuth.mockResolvedValue(VALID_USER);
  mockedCheckPerm.mockResolvedValue(null);
  mockedRequireMember.mockResolvedValue(null);
  mockedGetLinks.mockResolvedValue([LINK_DTO]);
  mockedGetByTarget.mockResolvedValue([LINK_DTO]);
  mockedCreate.mockResolvedValue(LINK_DTO);
  mockedDelete.mockResolvedValue(true);
});

// ============================================================
// GET
// ============================================================
describe('GET /idea/links', () => {
  it('sourceType+sourceId でリンク一覧を返す', async () => {
    const url = `http://localhost?sourceType=voting_session&sourceId=${SRC_ID}`;
    const res = await GET(new Request(url) as never, mockParams('p-1'));
    expect(res.status).toBe(200);
    expect(mockedGetLinks).toHaveBeenCalledWith('voting_session', SRC_ID, VALID_USER.tenantId);
  });

  it('targetType+targetId で逆引きする', async () => {
    const url = `http://localhost?targetType=task&targetId=${TGT_ID}`;
    const res = await GET(new Request(url) as never, mockParams('p-1'));
    expect(res.status).toBe(200);
    expect(mockedGetByTarget).toHaveBeenCalledWith('task', TGT_ID, VALID_USER.tenantId);
  });

  it('パラメータなしは 400', async () => {
    const res = await GET(new Request('http://localhost') as never, mockParams('p-1'));
    expect(res.status).toBe(400);
  });

  it('不正な sourceType は 400', async () => {
    const res = await GET(
      new Request(`http://localhost?sourceType=invalid&sourceId=${SRC_ID}`) as never,
      mockParams('p-1'),
    );
    expect(res.status).toBe(400);
  });
});

// ============================================================
// POST
// ============================================================
describe('POST /idea/links', () => {
  const VALID_BODY = {
    sourceType: 'voting_session',
    sourceId: SRC_ID,
    targetType: 'task',
    targetId: TGT_ID,
  };

  it('リンクを作成して 201', async () => {
    const res = await POST(
      new Request('http://localhost', { method: 'POST', body: JSON.stringify(VALID_BODY) }) as never,
      mockParams('p-1'),
    );
    expect(res.status).toBe(201);
  });

  it('TARGET_NOT_FOUND で 404', async () => {
    mockedCreate.mockRejectedValueOnce(new Error('TARGET_NOT_FOUND'));
    const res = await POST(
      new Request('http://localhost', { method: 'POST', body: JSON.stringify(VALID_BODY) }) as never,
      mockParams('p-1'),
    );
    expect(res.status).toBe(404);
  });

  it('ALREADY_LINKED で 409', async () => {
    mockedCreate.mockRejectedValueOnce(new Error('ALREADY_LINKED'));
    const res = await POST(
      new Request('http://localhost', { method: 'POST', body: JSON.stringify(VALID_BODY) }) as never,
      mockParams('p-1'),
    );
    expect(res.status).toBe(409);
  });
});

// ============================================================
// DELETE
// ============================================================
describe('DELETE /idea/links', () => {
  it('linkId なしは 400', async () => {
    const res = await DELETE(new Request('http://localhost') as never, mockParams('p-1'));
    expect(res.status).toBe(400);
  });

  it('リンクを削除して 204', async () => {
    const res = await DELETE(
      new Request(`http://localhost?linkId=${LINK_ID}`) as never,
      mockParams('p-1'),
    );
    expect(res.status).toBe(204);
  });

  it('存在しない場合は 404', async () => {
    mockedDelete.mockResolvedValueOnce(false);
    const res = await DELETE(
      new Request(`http://localhost?linkId=${LINK_ID}`) as never,
      mockParams('p-1'),
    );
    expect(res.status).toBe(404);
  });
});
