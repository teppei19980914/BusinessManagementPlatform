import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * PR I (2026-05-09 / #1): /guide ページの auth リダイレクトとロール別 initialTab を検証。
 *
 * 検証戦略: server component を React レンダラなしで呼び、返却される ReactElement の
 *   .props を直接読む。GuideClient は mock 不要 (props だけ確認したい)。
 *   実際のレンダリングは E2E / 視覚回帰側で別途カバー。
 */

const authMock = vi.fn();
vi.mock('@/lib/auth', () => ({ auth: () => authMock() }));

vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`__REDIRECT__:${url}`);
  }),
}));

import GuidePage from './page';

describe('GuidePage', () => {
  beforeEach(() => {
    authMock.mockReset();
  });

  it('未認証なら /login にリダイレクト', async () => {
    authMock.mockResolvedValue(null);
    await expect(GuidePage()).rejects.toThrow('__REDIRECT__:/login');
  });

  it('admin ロールなら initialTab=admin で client に渡す', async () => {
    authMock.mockResolvedValue({
      user: { id: 'u1', name: '太郎', email: 'a@b.c', systemRole: 'admin' },
    });
    const element = (await GuidePage()) as React.ReactElement<{
      initialTab: string;
      userName: string;
    }>;
    expect(element.props.initialTab).toBe('admin');
    expect(element.props.userName).toBe('太郎');
  });

  it('super_admin ロールも initialTab=admin', async () => {
    authMock.mockResolvedValue({
      user: { id: 'u1', name: '運営', email: 's@b.c', systemRole: 'super_admin' },
    });
    const element = (await GuidePage()) as React.ReactElement<{ initialTab: string }>;
    expect(element.props.initialTab).toBe('admin');
  });

  it('general ロールなら initialTab=member', async () => {
    authMock.mockResolvedValue({
      user: { id: 'u1', name: '次郎', email: 'b@b.c', systemRole: 'general' },
    });
    const element = (await GuidePage()) as React.ReactElement<{
      initialTab: string;
      userName: string;
    }>;
    expect(element.props.initialTab).toBe('member');
    expect(element.props.userName).toBe('次郎');
  });
});
