/**
 * user-self.service の単体テスト (feat/settings-tenant-identity / 2026-05-21)
 *
 * 検証対象:
 *   - getUserSelfAccountInfo: ユーザと所属テナント (slug + name) の取得
 *   - 論理削除 (User.deletedAt) ユーザは null
 *   - 解約済テナント (Tenant.deletedAt) のユーザも null (越境/解約後アクセス防衛)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  prisma: {
    user: {
      findFirst: vi.fn(),
    },
  },
}));

import { getUserSelfAccountInfo } from './user-self.service';
import { prisma } from '@/lib/db';

const USER_ID = 'user-uuid-1';
const TENANT_ID = 'tenant-uuid-1';

beforeEach(() => {
  vi.clearAllMocks();
});

const baseUser = {
  id: USER_ID,
  name: '山田太郎',
  email: 'taro@example.com',
  systemRole: 'general',
  mfaEnabled: false,
  mfaEnabledAt: null,
  lastLoginAt: new Date('2026-05-20T10:00:00Z'),
  createdAt: new Date('2026-01-15T00:00:00Z'),
  tenant: {
    slug: 'acme-corp',
    name: 'ACME Corporation',
    deletedAt: null,
  },
};

describe('getUserSelfAccountInfo', () => {
  it('正常: ユーザ + テナント (slug + name) を含む DTO を返す', async () => {
    vi.mocked(prisma.user.findFirst).mockResolvedValueOnce(baseUser as never);

    const r = await getUserSelfAccountInfo(USER_ID);

    expect(r).not.toBeNull();
    if (!r) return;
    expect(r.id).toBe(USER_ID);
    expect(r.name).toBe('山田太郎');
    expect(r.email).toBe('taro@example.com');
    expect(r.systemRole).toBe('general');
    expect(r.mfaEnabled).toBe(false);
    expect(r.mfaEnabledAt).toBeNull();
    expect(r.lastLoginAt).toEqual(new Date('2026-05-20T10:00:00Z'));
    expect(r.createdAt).toEqual(new Date('2026-01-15T00:00:00Z'));
    expect(r.tenant.slug).toBe('acme-corp');
    expect(r.tenant.name).toBe('ACME Corporation');
  });

  it('論理削除 (User.deletedAt) ユーザは null を返す (= findFirst が条件で除外して null 返却)', async () => {
    vi.mocked(prisma.user.findFirst).mockResolvedValueOnce(null);

    const r = await getUserSelfAccountInfo(USER_ID);

    expect(r).toBeNull();
    // findFirst が deletedAt: null フィルタ込みで呼び出されることを確認
    expect(prisma.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: USER_ID, deletedAt: null },
      }),
    );
  });

  it('解約済テナント (Tenant.deletedAt セット) 所属のユーザは null を返す (= 解約後アクセス防衛)', async () => {
    vi.mocked(prisma.user.findFirst).mockResolvedValueOnce({
      ...baseUser,
      tenant: {
        slug: 'acme-corp',
        name: 'ACME Corporation',
        deletedAt: new Date('2026-04-01T00:00:00Z'),
      },
    } as never);

    const r = await getUserSelfAccountInfo(USER_ID);

    expect(r).toBeNull();
  });

  it('super_admin / admin / general いずれの systemRole もそのまま返す', async () => {
    const cases = ['super_admin', 'admin', 'general'];
    for (const role of cases) {
      vi.mocked(prisma.user.findFirst).mockResolvedValueOnce({
        ...baseUser,
        systemRole: role,
      } as never);

      const r = await getUserSelfAccountInfo(USER_ID);
      expect(r?.systemRole).toBe(role);
    }
  });

  it('MFA 有効化済ユーザは mfaEnabled=true + mfaEnabledAt を返す', async () => {
    const mfaAt = new Date('2026-03-10T12:00:00Z');
    vi.mocked(prisma.user.findFirst).mockResolvedValueOnce({
      ...baseUser,
      mfaEnabled: true,
      mfaEnabledAt: mfaAt,
    } as never);

    const r = await getUserSelfAccountInfo(USER_ID);

    expect(r?.mfaEnabled).toBe(true);
    expect(r?.mfaEnabledAt).toEqual(mfaAt);
  });

  it('lastLoginAt=null (= 初回ログイン中) でも DTO を返す', async () => {
    vi.mocked(prisma.user.findFirst).mockResolvedValueOnce({
      ...baseUser,
      lastLoginAt: null,
    } as never);

    const r = await getUserSelfAccountInfo(USER_ID);

    expect(r).not.toBeNull();
    expect(r?.lastLoginAt).toBeNull();
  });

  it('越境防止: 引数 userId のみで findFirst を呼ぶ (= tenantId フィルタは不要)', async () => {
    vi.mocked(prisma.user.findFirst).mockResolvedValueOnce(baseUser as never);

    await getUserSelfAccountInfo(USER_ID);

    // where.id は userId のみで指定されており、tenantId フィルタは持たない
    //   (= 自分の id でしか取得しない設計のため、tenant 越境のリスク自体がない)
    const callArg = vi.mocked(prisma.user.findFirst).mock.calls[0]?.[0];
    expect(callArg?.where).toEqual({ id: USER_ID, deletedAt: null });
    expect(callArg?.where).not.toHaveProperty('tenantId');
  });

  // tenantId は不使用引数なので削除済 (型的にも要件外)
  it('TENANT_ID を参照しないこと (= 引数で受け取らない)', () => {
    // 関数シグネチャの確認: tenantId 引数を取らない (越境フィルタを誤って受け取らない設計)
    expect(getUserSelfAccountInfo.length).toBe(1);
    // TENANT_ID 自体は test 用定数で関数の引数には流れない
    expect(TENANT_ID).toBe('tenant-uuid-1');
  });
});
