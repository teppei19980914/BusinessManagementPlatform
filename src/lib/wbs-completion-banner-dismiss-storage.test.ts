import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  isWbsCompletionBannerDismissed,
  dismissWbsCompletionBanner,
  purgeAllWbsCompletionBannerDismiss,
} from './wbs-completion-banner-dismiss-storage';

// node 環境用の最小 sessionStorage モック (length / key(i) を含む実装で purge を検証する)。
// chat-history-storage.test.ts と同パターン。
class MemoryStorage {
  private map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  key(i: number): string | null {
    return Array.from(this.map.keys())[i] ?? null;
  }
  getItem(k: string): string | null {
    return this.map.has(k) ? (this.map.get(k) as string) : null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, v);
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
  clear(): void {
    this.map.clear();
  }
}

let storage: MemoryStorage;

beforeEach(() => {
  storage = new MemoryStorage();
  (globalThis as unknown as { window: unknown }).window = { sessionStorage: storage };
});

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
});

describe('isWbsCompletionBannerDismissed / dismissWbsCompletionBanner', () => {
  it('未破棄なら false', () => {
    expect(isWbsCompletionBannerDismissed('u-1', 'p-1')).toBe(false);
  });

  it('破棄すると true になる', () => {
    dismissWbsCompletionBanner('u-1', 'p-1');
    expect(isWbsCompletionBannerDismissed('u-1', 'p-1')).toBe(true);
  });

  it('別プロジェクトの破棄は影響しない', () => {
    dismissWbsCompletionBanner('u-1', 'p-1');
    expect(isWbsCompletionBannerDismissed('u-1', 'p-2')).toBe(false);
  });

  it('別ユーザの破棄状態は引き継がない (userId スコープ)', () => {
    dismissWbsCompletionBanner('u-1', 'p-1');
    expect(isWbsCompletionBannerDismissed('u-2', 'p-1')).toBe(false);
  });

  it('同じプロジェクトを 2 回破棄しても重複追加しない', () => {
    dismissWbsCompletionBanner('u-1', 'p-1');
    dismissWbsCompletionBanner('u-1', 'p-1');
    const raw = storage.getItem('tasukiba_dismissed_wbs_completion_banner_v1:u-1');
    expect(JSON.parse(raw ?? '[]')).toEqual(['p-1']);
  });

  it('同一ユーザの複数プロジェクトを集合で保持する', () => {
    dismissWbsCompletionBanner('u-1', 'p-1');
    dismissWbsCompletionBanner('u-1', 'p-2');
    expect(isWbsCompletionBannerDismissed('u-1', 'p-1')).toBe(true);
    expect(isWbsCompletionBannerDismissed('u-1', 'p-2')).toBe(true);
  });
});

describe('purgeAllWbsCompletionBannerDismiss', () => {
  it('全ユーザ分の破棄状態を削除する (ログアウト時の再表示用)', () => {
    dismissWbsCompletionBanner('u-1', 'p-1');
    dismissWbsCompletionBanner('u-2', 'p-1');
    purgeAllWbsCompletionBannerDismiss();
    expect(isWbsCompletionBannerDismissed('u-1', 'p-1')).toBe(false);
    expect(isWbsCompletionBannerDismissed('u-2', 'p-1')).toBe(false);
  });

  it('無関係な sessionStorage キーは残す', () => {
    storage.setItem('unrelated_key', 'value');
    dismissWbsCompletionBanner('u-1', 'p-1');
    purgeAllWbsCompletionBannerDismiss();
    expect(storage.getItem('unrelated_key')).toBe('value');
  });
});

describe('window 未定義 (SSR) 時のフォールバック', () => {
  it('isWbsCompletionBannerDismissed は false を返す', () => {
    delete (globalThis as unknown as { window?: unknown }).window;
    expect(isWbsCompletionBannerDismissed('u-1', 'p-1')).toBe(false);
  });

  it('dismissWbsCompletionBanner / purgeAllWbsCompletionBannerDismiss は例外を投げない', () => {
    delete (globalThis as unknown as { window?: unknown }).window;
    expect(() => dismissWbsCompletionBanner('u-1', 'p-1')).not.toThrow();
    expect(() => purgeAllWbsCompletionBannerDismiss()).not.toThrow();
  });
});
