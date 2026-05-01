import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * /api/attachments/batch の lenient validation テスト (PR fix/attachments-batch-400)。
 *
 * 主な仕様:
 *   - entityType / slot は厳格 (固定値、ミスマッチ → 400)
 *   - entityIds は lenient: 配列でない / 非 UUID 要素 → 黙ってフィルタ + 200
 *   - 全件無効 → 200 + 空 Map
 */

vi.mock('@/lib/db', () => ({
  prisma: {
    attachment: {
      findMany: vi.fn(),
    },
    memo: { findMany: vi.fn() },
    projectMember: { findMany: vi.fn() },
    task: { findMany: vi.fn() },
    estimate: { findMany: vi.fn() },
    riskIssue: { findMany: vi.fn() },
    retrospective: { findMany: vi.fn() },
    knowledge: { findMany: vi.fn() },
    knowledgeProject: { findMany: vi.fn() },
  },
}));

vi.mock('@/lib/api-helpers', () => ({
  getAuthenticatedUser: vi.fn(),
}));

vi.mock('@/services/error-log.service', () => ({
  recordError: vi.fn(),
}));

import { POST } from './route';
import { prisma } from '@/lib/db';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { recordError } from '@/services/error-log.service';

const VALID_UUID_1 = 'd8c247e5-cdfe-4e26-a84f-2c2e956cd65a';
const VALID_UUID_2 = '5fffb178-950a-4172-aa12-cc76fb653a0b';

function postReq(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/attachments/batch', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getAuthenticatedUser).mockResolvedValue({ id: 'u-admin', systemRole: 'admin' } as never);
  vi.mocked(prisma.attachment.findMany).mockResolvedValue([] as never);
});

describe('POST /api/attachments/batch — lenient entityIds', () => {
  it('全 ID が有効 UUID なら 200 + データ取得', async () => {
    const res = await POST(postReq({
      entityType: 'task',
      entityIds: [VALID_UUID_1, VALID_UUID_2],
    }));
    expect(res.status).toBe(200);
    expect(prisma.attachment.findMany).toHaveBeenCalledOnce();
  });

  it('一部 ID が非 UUID でも 200 (有効分のみ処理)', async () => {
    const res = await POST(postReq({
      entityType: 'task',
      entityIds: [VALID_UUID_1, 'not-a-uuid', '', 'temp-staging-id'],
    }));
    expect(res.status).toBe(200);
    // 有効 ID 1 件だけが prisma に渡る
    const call = vi.mocked(prisma.attachment.findMany).mock.calls[0]?.[0];
    expect((call?.where as { entityId?: { in?: unknown } } | undefined)?.entityId).toEqual({ in: [VALID_UUID_1] });
    // フィルタ発動の info ログが system_error_logs (recordError) に出る
    expect(recordError).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: 'info',
        message: expect.stringContaining('filtered 3/4'),
      }),
    );
  });

  it('全 ID が無効 UUID なら 200 + 空 Map (DB 問い合わせなし)', async () => {
    const res = await POST(postReq({
      entityType: 'task',
      entityIds: ['bad-1', 'bad-2'],
    }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ data: {} });
    expect(prisma.attachment.findMany).not.toHaveBeenCalled();
  });

  it('entityIds が array でなければ空配列扱い (200 + 空 Map)', async () => {
    const res = await POST(postReq({
      entityType: 'task',
      entityIds: 'not-an-array',
    }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ data: {} });
  });

  it('entityIds が undefined でも 200 + 空 Map', async () => {
    const res = await POST(postReq({ entityType: 'task' }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ data: {} });
  });
});

describe('POST /api/attachments/batch — entityType / slot は厳格', () => {
  it('entityType が ATTACHMENT_ENTITY_TYPES 外なら 400 + recordError', async () => {
    const res = await POST(postReq({
      entityType: 'comment', // ATTACHMENT_ENTITY_TYPES に含まれない (Comment は別 polymorphic system)
      entityIds: [VALID_UUID_1],
    }));
    expect(res.status).toBe(400);
    expect(recordError).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: 'warn',
        message: '[attachments/batch] header validation failed',
        context: expect.objectContaining({ entityType: 'comment' }),
      }),
    );
  });

  it('entityType が undefined なら 400 + (typeof) を context に出す', async () => {
    const res = await POST(postReq({ entityIds: [VALID_UUID_1] }));
    expect(res.status).toBe(400);
    expect(recordError).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({ entityType: '(undefined)' }),
      }),
    );
  });

  it('slot が 30 文字超なら 400', async () => {
    const res = await POST(postReq({
      entityType: 'task',
      entityIds: [VALID_UUID_1],
      slot: 'x'.repeat(31),
    }));
    expect(res.status).toBe(400);
  });
});

describe('POST /api/attachments/batch — 認証', () => {
  it('未認証は getAuthenticatedUser が返す NextResponse をそのまま返す', async () => {
    const { NextResponse } = await import('next/server');
    const unauthResp = NextResponse.json({ error: 'UNAUTHENTICATED' }, { status: 401 });
    vi.mocked(getAuthenticatedUser).mockResolvedValue(unauthResp as never);
    const res = await POST(postReq({ entityType: 'task', entityIds: [VALID_UUID_1] }));
    expect(res.status).toBe(401);
  });
});
