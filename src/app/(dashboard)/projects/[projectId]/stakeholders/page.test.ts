import { describe, it, expect, vi } from 'vitest';
import ProjectStakeholdersLegacyRedirect from './page';

vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`__REDIRECT__:${url}`);
  }),
}));

describe('ProjectStakeholdersLegacyRedirect (PR #207-#212 互換)', () => {
  it('?stakeholderId=... 付きで来たら /projects/[id]?tab=stakeholders&stakeholderId=... にリダイレクト', async () => {
    await expect(
      ProjectStakeholdersLegacyRedirect({
        params: Promise.resolve({ projectId: 'p-1' }),
        searchParams: Promise.resolve({ stakeholderId: 's-1' }),
      }),
    ).rejects.toThrow('__REDIRECT__:/projects/p-1?tab=stakeholders&stakeholderId=s-1');
  });

  it('query なしなら /projects/[id]?tab=stakeholders にリダイレクト', async () => {
    await expect(
      ProjectStakeholdersLegacyRedirect({
        params: Promise.resolve({ projectId: 'p-1' }),
        searchParams: Promise.resolve({}),
      }),
    ).rejects.toThrow('__REDIRECT__:/projects/p-1?tab=stakeholders');
  });
});
