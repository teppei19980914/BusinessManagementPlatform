import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  CHAT_SEARCH_HISTORY_BASE_KEY,
  loadScopedHistory,
  saveScopedHistory,
  clearScopedHistory,
  purgeOtherUsersHistory,
  purgeAllHistory,
} from './chat-history-storage';

// node 環境用の最小 sessionStorage モック (length / key(i) を含む実装で purge を検証する)。
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

type Turn = { id: string; userQuery: string };
function isTurn(item: unknown): item is Turn {
  return (
    item !== null &&
    typeof item === 'object' &&
    typeof (item as { id?: unknown }).id === 'string' &&
    typeof (item as { userQuery?: unknown }).userQuery === 'string'
  );
}

const BASE = CHAT_SEARCH_HISTORY_BASE_KEY;
const MAX = 50;

let storage: MemoryStorage;

beforeEach(() => {
  storage = new MemoryStorage();
  (globalThis as unknown as { window: unknown }).window = { sessionStorage: storage };
});

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
});

describe('chat-history-storage: ユーザスコープ保存/読込', () => {
  it('保存はユーザ ID 付きキーに書き、別ユーザでは読めない', () => {
    saveScopedHistory(BASE, 'userA', [{ id: '1', userQuery: 'a の質問' }], MAX);
    expect(storage.getItem(`${BASE}:userA`)).toContain('a の質問');
    // 別ユーザ B はそのキーを参照しないので空
    expect(loadScopedHistory(BASE, 'userB', isTurn, MAX)).toEqual([]);
    // 本人 A は読める
    expect(loadScopedHistory(BASE, 'userA', isTurn, MAX)).toEqual([
      { id: '1', userQuery: 'a の質問' },
    ]);
  });

  it('shape 不整合 / 非配列は [] にフォールバックする', () => {
    storage.setItem(`${BASE}:userA`, JSON.stringify({ not: 'array' }));
    expect(loadScopedHistory(BASE, 'userA', isTurn, MAX)).toEqual([]);
    storage.setItem(`${BASE}:userA`, '{ broken json');
    expect(loadScopedHistory(BASE, 'userA', isTurn, MAX)).toEqual([]);
  });

  it('maxTurns を超える履歴は読込時・保存時とも末尾 maxTurns 件に trim される', () => {
    const many = Array.from({ length: 60 }, (_v, i) => ({ id: String(i), userQuery: `q${i}` }));
    saveScopedHistory(BASE, 'userA', many, MAX);
    const loaded = loadScopedHistory(BASE, 'userA', isTurn, MAX);
    expect(loaded).toHaveLength(MAX);
    expect(loaded[0]?.id).toBe('10'); // 古い 10 件が捨てられる
    expect(loaded[MAX - 1]?.id).toBe('59');
  });
});

describe('chat-history-storage: 越境防御 (purge)', () => {
  it('purgeOtherUsersHistory は他ユーザ分と旧固定キーを消し、現ユーザ分は残す', () => {
    saveScopedHistory(BASE, 'userA', [{ id: '1', userQuery: 'A' }], MAX);
    saveScopedHistory(BASE, 'userB', [{ id: '2', userQuery: 'B' }], MAX);
    storage.setItem(BASE, JSON.stringify([{ id: '0', userQuery: 'legacy' }])); // 旧固定キー
    // 無関係キーは保持されること
    storage.setItem('tasukiba_chat_panel_mode_v1', 'help');

    purgeOtherUsersHistory(BASE, 'userB');

    expect(storage.getItem(`${BASE}:userA`)).toBeNull(); // 他ユーザ削除
    expect(storage.getItem(BASE)).toBeNull(); // 旧固定キー削除
    expect(storage.getItem(`${BASE}:userB`)).not.toBeNull(); // 現ユーザは残る
    expect(storage.getItem('tasukiba_chat_panel_mode_v1')).toBe('help'); // 無関係キーは無傷
  });

  it('purgeAllHistory は全ユーザ分 + 旧固定キーを消す (ログアウト用)', () => {
    saveScopedHistory(BASE, 'userA', [{ id: '1', userQuery: 'A' }], MAX);
    saveScopedHistory(BASE, 'userB', [{ id: '2', userQuery: 'B' }], MAX);
    storage.setItem(BASE, '[]');
    storage.setItem('tasukiba_chat_panel_mode_v1', 'search');

    purgeAllHistory(BASE);

    expect(storage.getItem(`${BASE}:userA`)).toBeNull();
    expect(storage.getItem(`${BASE}:userB`)).toBeNull();
    expect(storage.getItem(BASE)).toBeNull();
    expect(storage.getItem('tasukiba_chat_panel_mode_v1')).toBe('search'); // 無関係キーは無傷
  });

  it('clearScopedHistory は現ユーザ分のみ消す', () => {
    saveScopedHistory(BASE, 'userA', [{ id: '1', userQuery: 'A' }], MAX);
    saveScopedHistory(BASE, 'userB', [{ id: '2', userQuery: 'B' }], MAX);
    clearScopedHistory(BASE, 'userA');
    expect(storage.getItem(`${BASE}:userA`)).toBeNull();
    expect(storage.getItem(`${BASE}:userB`)).not.toBeNull();
  });

  it('A→B シナリオ: B ログイン時 purge → B は A の履歴を一切読めない', () => {
    // A がチャット
    saveScopedHistory(BASE, 'userA', [{ id: '1', userQuery: 'A の秘密' }], MAX);
    // 旧実装の固定キー残骸も再現
    storage.setItem(BASE, JSON.stringify([{ id: '1', userQuery: 'A の秘密' }]));

    // B ログイン (full-navigation 後の最初の load 相当)
    purgeOtherUsersHistory(BASE, 'userB');
    const bHistory = loadScopedHistory(BASE, 'userB', isTurn, MAX);

    expect(bHistory).toEqual([]);
    // ストレージ上にも A の痕跡が残っていない
    expect(storage.getItem(`${BASE}:userA`)).toBeNull();
    expect(storage.getItem(BASE)).toBeNull();
  });
});
