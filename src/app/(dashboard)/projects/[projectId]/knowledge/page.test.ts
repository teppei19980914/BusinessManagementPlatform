import { describe, it, expect, vi } from 'vitest';
import ProjectKnowledgeLegacyRedirect from './page';

vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => {
    // next.js redirect throws a special error to halt rendering.
    // テストでは throw された URL を引数として捕捉する。
    throw new Error(`__REDIRECT__:${url}`);
  }),
}));

describe('ProjectKnowledgeLegacyRedirect (PR #207-#211 互換)', () => {
  it('?knowledgeId=... 付きで来たら /knowledge?knowledgeId=... にリダイレクト', async () => {
    await expect(
      ProjectKnowledgeLegacyRedirect({
        params: Promise.resolve({ projectId: 'p-1' }),
        searchParams: Promise.resolve({ knowledgeId: 'k-1' }),
      }),
    ).rejects.toThrow('__REDIRECT__:/knowledge?knowledgeId=k-1');
  });

  it('query なしなら /knowledge にリダイレクト', async () => {
    await expect(
      ProjectKnowledgeLegacyRedirect({
        params: Promise.resolve({ projectId: 'p-1' }),
        searchParams: Promise.resolve({}),
      }),
    ).rejects.toThrow('__REDIRECT__:/knowledge');
  });
});
