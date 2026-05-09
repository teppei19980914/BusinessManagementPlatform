import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * PR I (2026-05-09 / #2): /help ページの auth + ロール条件分岐を検証。
 *
 * 検証戦略: server component を React レンダラなしで呼び、返却される ReactElement の
 *   .props を直接読む (HelpClient は実際にはレンダリングされない、props だけ確認)。
 */

const authMock = vi.fn();
vi.mock('@/lib/auth', () => ({ auth: () => authMock() }));

vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`__REDIRECT__:${url}`);
  }),
}));

import HelpPage from './page';

describe('HelpPage', () => {
  beforeEach(() => {
    authMock.mockReset();
  });

  it('未認証なら /login にリダイレクト', async () => {
    authMock.mockResolvedValue(null);
    await expect(HelpPage()).rejects.toThrow('__REDIRECT__:/login');
  });

  it('admin なら isTenantAdmin=true (生成 AI セクション表示)', async () => {
    authMock.mockResolvedValue({
      user: { id: 'u1', name: 'admin', email: 'a@b.c', systemRole: 'admin' },
    });
    const element = (await HelpPage()) as React.ReactElement<{ isTenantAdmin: boolean }>;
    expect(element.props.isTenantAdmin).toBe(true);
  });

  it('super_admin なら isTenantAdmin=true', async () => {
    authMock.mockResolvedValue({
      user: { id: 'u1', name: 'super', email: 's@b.c', systemRole: 'super_admin' },
    });
    const element = (await HelpPage()) as React.ReactElement<{ isTenantAdmin: boolean }>;
    expect(element.props.isTenantAdmin).toBe(true);
  });

  it('general なら isTenantAdmin=false (一般 FAQ のみ)', async () => {
    authMock.mockResolvedValue({
      user: { id: 'u1', name: 'g', email: 'g@b.c', systemRole: 'general' },
    });
    const element = (await HelpPage()) as React.ReactElement<{ isTenantAdmin: boolean }>;
    expect(element.props.isTenantAdmin).toBe(false);
  });
});
