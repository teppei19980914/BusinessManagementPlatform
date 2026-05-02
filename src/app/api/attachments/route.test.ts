/**
 * /api/attachments の認可テスト (PR #213 / 2026-05-01)。
 *
 * 主要シナリオ: 「全○○」(cross-list) の readOnly dialog から非メンバーが添付一覧を
 *   取得する経路の救済 (visibility='public' なら誰でも閲覧可)。Vercel runtime log で
 *   観測された 403 多発を再現できないよう regression を防止する。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/api-helpers', () => ({
  getAuthenticatedUser: vi.fn(),
}));

vi.mock('@/lib/permissions', () => ({
  checkMembership: vi.fn(),
}));

vi.mock('@/services/attachment.service', () => ({
  authorizeMemoAttachment: vi.fn(),
  createAttachment: vi.fn(),
  getEntityVisibility: vi.fn(),
  listAttachments: vi.fn(),
  resolveProjectIds: vi.fn(),
}));

vi.mock('@/services/audit.service', () => ({
  recordAuditLog: vi.fn(),
}));

vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn(async () => (key: string) => key),
}));

import { GET } from './route';
import { NextRequest } from 'next/server';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { checkMembership } from '@/lib/permissions';
import {
  getEntityVisibility,
  listAttachments,
} from '@/services/attachment.service';

const ENTITY_ID = 'a0a0a0a0-1111-2222-3333-444444444444';
function getReq(entityType: string, entityId: string): NextRequest {
  return new NextRequest(`http://x/api/attachments?entityType=${entityType}&entityId=${entityId}`);
}

describe('GET /api/attachments — visibility-aware read 認可 (PR #213)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listAttachments).mockResolvedValue([]);
  });

  it('risk (public): 非 project member でも 200', async () => {
    // 「全リスク」から readOnly dialog を開いて AttachmentList が GET したケース
    vi.mocked(getAuthenticatedUser).mockResolvedValue({ id: 'u-out', systemRole: 'general' } as never);
    vi.mocked(getEntityVisibility).mockResolvedValue({ visibility: 'public', creatorId: 'u-creator' });
    const res = await GET(getReq('risk', ENTITY_ID));
    expect(res.status).toBe(200);
    expect(checkMembership).not.toHaveBeenCalled();
  });

  it('risk (draft): 作成者本人なら 200', async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue({ id: 'u-creator', systemRole: 'general' } as never);
    vi.mocked(getEntityVisibility).mockResolvedValue({ visibility: 'draft', creatorId: 'u-creator' });
    const res = await GET(getReq('risk', ENTITY_ID));
    expect(res.status).toBe(200);
  });

  it('risk (draft): 作成者でも admin でもなければ 403', async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue({ id: 'u-other', systemRole: 'general' } as never);
    vi.mocked(getEntityVisibility).mockResolvedValue({ visibility: 'draft', creatorId: 'u-creator' });
    const res = await GET(getReq('risk', ENTITY_ID));
    expect(res.status).toBe(403);
  });

  it('retrospective (public): 非 project member でも 200', async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue({ id: 'u-out', systemRole: 'general' } as never);
    vi.mocked(getEntityVisibility).mockResolvedValue({ visibility: 'public', creatorId: 'u-creator' });
    const res = await GET(getReq('retrospective', ENTITY_ID));
    expect(res.status).toBe(200);
  });

  it('knowledge (public): 非 project member でも 200', async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue({ id: 'u-out', systemRole: 'general' } as never);
    vi.mocked(getEntityVisibility).mockResolvedValue({ visibility: 'public', creatorId: 'u-creator' });
    const res = await GET(getReq('knowledge', ENTITY_ID));
    expect(res.status).toBe(200);
  });

  it('risk が not-found: 404', async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue({ id: 'u-out', systemRole: 'general' } as never);
    vi.mocked(getEntityVisibility).mockResolvedValue('not-found');
    const res = await GET(getReq('risk', ENTITY_ID));
    expect(res.status).toBe(404);
  });

  it('admin: visibility に関わらず 200 (visibility-check すらスキップ)', async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue({ id: 'u-admin', systemRole: 'admin' } as never);
    const res = await GET(getReq('risk', ENTITY_ID));
    expect(res.status).toBe(200);
    // admin path は早期 return するため getEntityVisibility 呼ばれない
    expect(getEntityVisibility).not.toHaveBeenCalled();
  });
});
