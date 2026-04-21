import { describe, it, expect, vi } from 'vitest';

// PgTrgmSearchProvider はコンストラクタで Prisma client を触らない軽量クラスのため
// モックは最小限で十分
vi.mock('./pg-trgm-provider', () => ({
  PgTrgmSearchProvider: class {
    async search() {
      return { items: [], total: 0 };
    }
  },
}));

import { createSearchProvider } from './index';

describe('createSearchProvider', () => {
  it('現在は PgTrgmSearchProvider を返す (環境変数分岐未実装)', () => {
    const provider = createSearchProvider();
    expect(provider).toBeDefined();
    expect(typeof provider.search).toBe('function');
  });
});
