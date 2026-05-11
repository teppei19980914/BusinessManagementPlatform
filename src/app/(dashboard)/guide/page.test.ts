import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * /guide ページの auth リダイレクト + ロール解決 + クライアント props 受け渡しを検証する。
 *
 * 2026-05-11 リファクタ: 旧仕様の initialTab (admin/member) ではなく、
 *   resolveGuideRole が返す GuideRole ('admin' | 'pm' | 'member' | 'viewer') を
 *   GuideClient に渡す形に変更。本テストは props 渡しの正当性のみ検証する。
 *   resolveGuideRole 自体の振る舞いは src/services/guide-role.service.test.ts で検証。
 */

const authMock = vi.fn();
vi.mock('@/lib/auth', () => ({ auth: () => authMock() }));

vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`__REDIRECT__:${url}`);
  }),
}));

const resolveGuideRoleMock = vi.fn();
vi.mock('@/services/guide-role.service', () => ({
  resolveGuideRole: (...args: unknown[]) => resolveGuideRoleMock(...args),
}));

import GuidePage from './page';

describe('GuidePage', () => {
  beforeEach(() => {
    authMock.mockReset();
    resolveGuideRoleMock.mockReset();
  });

  it('未認証なら /login にリダイレクト', async () => {
    authMock.mockResolvedValue(null);
    await expect(GuidePage()).rejects.toThrow('__REDIRECT__:/login');
    // resolveGuideRole は呼ばれない (早期 return)
    expect(resolveGuideRoleMock).not.toHaveBeenCalled();
  });

  it('admin ロールなら role=admin を client に渡す', async () => {
    authMock.mockResolvedValue({
      user: { id: 'u1', name: '太郎', email: 'a@b.c', systemRole: 'admin' },
    });
    resolveGuideRoleMock.mockResolvedValue('admin');

    const element = (await GuidePage()) as React.ReactElement<{
      role: string;
      systemRole: string;
      userName: string;
    }>;
    expect(element.props.role).toBe('admin');
    expect(element.props.systemRole).toBe('admin');
    expect(element.props.userName).toBe('太郎');

    // resolveGuideRole は userId + systemRole で呼ばれる
    expect(resolveGuideRoleMock).toHaveBeenCalledWith('u1', 'admin');
  });

  it('super_admin ロールも role=admin で client に渡す + systemRole は維持', async () => {
    authMock.mockResolvedValue({
      user: { id: 'u1', name: '運営', email: 's@b.c', systemRole: 'super_admin' },
    });
    resolveGuideRoleMock.mockResolvedValue('admin');

    const element = (await GuidePage()) as React.ReactElement<{
      role: string;
      systemRole: string;
    }>;
    expect(element.props.role).toBe('admin');
    expect(element.props.systemRole).toBe('super_admin');
  });

  it('general + PM/PL なら role=pm', async () => {
    authMock.mockResolvedValue({
      user: { id: 'u1', name: '次郎', email: 'b@b.c', systemRole: 'general' },
    });
    resolveGuideRoleMock.mockResolvedValue('pm');

    const element = (await GuidePage()) as React.ReactElement<{ role: string }>;
    expect(element.props.role).toBe('pm');
  });

  it('general + 一般メンバー なら role=member', async () => {
    authMock.mockResolvedValue({
      user: { id: 'u1', name: '次郎', email: 'b@b.c', systemRole: 'general' },
    });
    resolveGuideRoleMock.mockResolvedValue('member');

    const element = (await GuidePage()) as React.ReactElement<{ role: string }>;
    expect(element.props.role).toBe('member');
  });

  it('general + 閲覧者 なら role=viewer', async () => {
    authMock.mockResolvedValue({
      user: { id: 'u1', name: '次郎', email: 'b@b.c', systemRole: 'general' },
    });
    resolveGuideRoleMock.mockResolvedValue('viewer');

    const element = (await GuidePage()) as React.ReactElement<{ role: string }>;
    expect(element.props.role).toBe('viewer');
  });

  it('userName が未設定なら空文字を渡す', async () => {
    authMock.mockResolvedValue({
      user: { id: 'u1', name: null, email: 'a@b.c', systemRole: 'admin' },
    });
    resolveGuideRoleMock.mockResolvedValue('admin');

    const element = (await GuidePage()) as React.ReactElement<{ userName: string }>;
    expect(element.props.userName).toBe('');
  });
});
