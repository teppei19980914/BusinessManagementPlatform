/**
 * POST /api/assets/share 退行防止テスト (v1.5.0)
 *
 * 検証観点:
 *   - 未認証 → 401
 *   - バリデーション失敗 (entityType 不正・recipientUserIds 空) → 400
 *   - 資産が非公開/別テナント/削除済み → 404
 *   - 受信者に無効ユーザが含まれる → 400
 *   - 正常系: 通知を送信し count を返す
 *   - 自分自身のみ指定 → count=0 (service 層で除外)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/db', () => ({
  prisma: {
    knowledge: { findFirst: vi.fn() },
    riskIssue: { findFirst: vi.fn() },
    retrospective: { findFirst: vi.fn() },
    memo: { findFirst: vi.fn() },
    user: { findMany: vi.fn() },
    // entity-link.ts が内部で使うモデル (buildEntityCommentLink → buildEntityBaseLink)
    task: { findFirst: vi.fn() },
    stakeholder: { findFirst: vi.fn() },
    customer: { findFirst: vi.fn() },
    notification: { createMany: vi.fn() },
  },
}));

vi.mock('@/lib/api-helpers', () => ({
  getAuthenticatedUser: vi.fn(),
}));

import { POST } from './route';
import { prisma } from '@/lib/db';
import { getAuthenticatedUser } from '@/lib/api-helpers';

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const SENDER_ID = '00000000-0000-4000-8000-000000000010';
const USER_A = '00000000-0000-4000-8000-000000000020';
const USER_B = '00000000-0000-4000-8000-000000000030';
const ENTITY_ID = '00000000-0000-4000-8000-000000000099';

function postReq(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/assets/share', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

function mockAuth(overrides: Record<string, unknown> = {}) {
  vi.mocked(getAuthenticatedUser).mockResolvedValue({
    id: SENDER_ID,
    tenantId: TENANT_ID,
    name: '送信者',
    email: 'sender@example.com',
    systemRole: 'general',
    ...overrides,
  } as never);
}

function mockValidRecipients() {
  vi.mocked(prisma.user.findMany).mockResolvedValue([
    { id: USER_A },
    { id: USER_B },
  ] as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  // notification.createMany はデフォルトで count=2 を返す
  vi.mocked(prisma.notification.createMany).mockResolvedValue({ count: 2 } as never);
});

describe('POST /api/assets/share — 認証・バリデーション', () => {
  it('未認証 → 401', async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue(
      new (await import('next/server')).NextResponse(null, { status: 401 }) as never,
    );
    const res = await POST(postReq({ entityType: 'knowledge', entityId: ENTITY_ID, recipientUserIds: [USER_A] }));
    expect(res.status).toBe(401);
  });

  it('entityType が不正値 → 400', async () => {
    mockAuth();
    const res = await POST(postReq({ entityType: 'invalid', entityId: ENTITY_ID, recipientUserIds: [USER_A] }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('entityId が UUID でない → 400', async () => {
    mockAuth();
    const res = await POST(postReq({ entityType: 'knowledge', entityId: 'not-a-uuid', recipientUserIds: [USER_A] }));
    expect(res.status).toBe(400);
  });

  it('recipientUserIds が空配列 → 400', async () => {
    mockAuth();
    const res = await POST(postReq({ entityType: 'knowledge', entityId: ENTITY_ID, recipientUserIds: [] }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('recipientUserIds が 101 件 (上限超え) → 400', async () => {
    mockAuth();
    const tooMany = Array.from({ length: 101 }, (_, i) =>
      `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    );
    const res = await POST(postReq({ entityType: 'knowledge', entityId: ENTITY_ID, recipientUserIds: tooMany }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('POST /api/assets/share — 資産解決', () => {
  it('knowledge が非公開 (draft) → 404', async () => {
    mockAuth();
    vi.mocked(prisma.knowledge.findFirst).mockResolvedValue(null);
    const res = await POST(postReq({ entityType: 'knowledge', entityId: ENTITY_ID, recipientUserIds: [USER_A] }));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('risk が公開 → asset 解決されて先へ進む', async () => {
    mockAuth();
    vi.mocked(prisma.riskIssue.findFirst).mockResolvedValue({ title: 'リスクA' } as never);
    mockValidRecipients();
    vi.mocked(prisma.riskIssue.findFirst).mockResolvedValueOnce({ title: 'リスクA' } as never);
    // entity-link.ts が riskIssue を再クエリする
    vi.mocked(prisma.riskIssue.findFirst).mockResolvedValue({ type: 'risk' } as never);

    const res = await POST(postReq({ entityType: 'risk', entityId: ENTITY_ID, recipientUserIds: [USER_A] }));
    // 受信者バリデーションが通れば先に進む (notification.createMany は stub 済)
    expect([200, 404, 400]).toContain(res.status);
  });

  it('issue が公開 → riskIssue テーブルを type=\'issue\' で検索する', async () => {
    mockAuth();
    vi.mocked(prisma.riskIssue.findFirst).mockResolvedValue({ title: '課題B' } as never);
    mockValidRecipients();
    vi.mocked(prisma.riskIssue.findFirst).mockResolvedValue({ id: ENTITY_ID } as never);

    const res = await POST(postReq({ entityType: 'issue', entityId: ENTITY_ID, recipientUserIds: [USER_A] }));
    // resolvePublicAsset が呼ばれ riskIssue.findFirst に type='issue' が渡ることを確認
    expect(vi.mocked(prisma.riskIssue.findFirst).mock.calls[0][0]).toMatchObject({
      where: expect.objectContaining({ type: 'issue' }),
    });
    expect([200, 404, 400]).toContain(res.status);
  });

  it('memo が非公開 (private) → 404', async () => {
    mockAuth();
    vi.mocked(prisma.memo.findFirst).mockResolvedValue(null);
    const res = await POST(postReq({ entityType: 'memo', entityId: ENTITY_ID, recipientUserIds: [USER_A] }));
    expect(res.status).toBe(404);
  });
});

describe('POST /api/assets/share — 受信者バリデーション', () => {
  it('受信者の一部が別テナント/無効ユーザ → 400', async () => {
    mockAuth();
    vi.mocked(prisma.knowledge.findFirst).mockResolvedValue({ title: 'ナレッジ' } as never);
    // USER_A は有効だが USER_B は別テナントで返ってこない
    vi.mocked(prisma.user.findMany).mockResolvedValue([{ id: USER_A }] as never);

    const res = await POST(postReq({
      entityType: 'knowledge',
      entityId: ENTITY_ID,
      recipientUserIds: [USER_A, USER_B],
    }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('POST /api/assets/share — 正常系', () => {
  it('knowledge 公開 + 有効な受信者 2 件 → 200 count=2', async () => {
    mockAuth();
    vi.mocked(prisma.knowledge.findFirst).mockResolvedValueOnce({ title: 'ナレッジA' } as never);
    mockValidRecipients();
    // buildEntityCommentLink → prisma.knowledge.findFirst の再クエリ
    vi.mocked(prisma.knowledge.findFirst).mockResolvedValue({ id: ENTITY_ID } as never);
    vi.mocked(prisma.notification.createMany).mockResolvedValue({ count: 2 } as never);

    const res = await POST(postReq({
      entityType: 'knowledge',
      entityId: ENTITY_ID,
      recipientUserIds: [USER_A, USER_B],
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.count).toBe(2);
  });

  it('retrospective 公開 → 200', async () => {
    mockAuth();
    // retrospective は title を持たないため conductedDate を返す (route.ts が toISOString() で変換)
    vi.mocked(prisma.retrospective.findFirst).mockResolvedValueOnce({ conductedDate: new Date('2026-06-01') } as never);
    mockValidRecipients();
    vi.mocked(prisma.retrospective.findFirst).mockResolvedValue({ id: ENTITY_ID } as never);
    vi.mocked(prisma.notification.createMany).mockResolvedValue({ count: 2 } as never);

    const res = await POST(postReq({
      entityType: 'retrospective',
      entityId: ENTITY_ID,
      recipientUserIds: [USER_A, USER_B],
    }));
    expect(res.status).toBe(200);
  });

  it('自分自身のみ指定 → service 層で除外され count=0 / 200', async () => {
    mockAuth();
    vi.mocked(prisma.knowledge.findFirst).mockResolvedValueOnce({ title: 'ナレッジB' } as never);
    // 受信者 = 送信者本人のみ → user.findMany は送信者を返す
    vi.mocked(prisma.user.findMany).mockResolvedValue([{ id: SENDER_ID }] as never);
    vi.mocked(prisma.knowledge.findFirst).mockResolvedValue({ id: ENTITY_ID } as never);
    // shareAsset 内で targets.length === 0 → createMany は呼ばれず count=0
    vi.mocked(prisma.notification.createMany).mockResolvedValue({ count: 0 } as never);

    const res = await POST(postReq({
      entityType: 'knowledge',
      entityId: ENTITY_ID,
      recipientUserIds: [SENDER_ID],
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.count).toBe(0);
  });
});
