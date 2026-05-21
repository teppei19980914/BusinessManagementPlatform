/**
 * tenant-history.ts のテスト。
 *
 * - localStorage の振る舞いを memoryStorage で mock (jsdom 未使用、Node 環境で動作)
 * - 不正データの検証・破棄を確認
 * - 90 日経過の expire を確認
 * - LRU + 5 件上限を確認
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getTenantHistory,
  recordTenantUsage,
  removeTenantFromHistory,
  clearTenantHistory,
  type TenantHistoryEntry,
} from './tenant-history';

const STORAGE_KEY = 'tasukiba.tenantHistory.v1';

function makeMemoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key: string) {
      return map.has(key) ? (map.get(key) as string) : null;
    },
    setItem(key: string, value: string) {
      map.set(key, value);
    },
    removeItem(key: string) {
      map.delete(key);
    },
    key(i: number) {
      return Array.from(map.keys())[i] ?? null;
    },
  };
}

// jsdom 未使用環境のため、globalThis.window を vi.stubGlobal で stub する
let mockStorage: Storage;

beforeEach(() => {
  mockStorage = makeMemoryStorage();
  vi.stubGlobal('window', { localStorage: mockStorage });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('tenant-history.getTenantHistory', () => {
  it('空のときは空配列を返す', () => {
    expect(getTenantHistory()).toEqual([]);
  });

  it('壊れた JSON は破棄して空配列を返す', () => {
    mockStorage.setItem(STORAGE_KEY, 'not a json {{{');
    expect(getTenantHistory()).toEqual([]);
    // 副作用: 浄化されている
    expect(mockStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('配列でないトップレベル値は破棄', () => {
    mockStorage.setItem(STORAGE_KEY, JSON.stringify({ slug: 'x', name: 'X' }));
    expect(getTenantHistory()).toEqual([]);
  });

  it('shape 不正なエントリは捨てる (slug pattern / name 空 / lastUsedAt invalid)', () => {
    const corrupt: unknown[] = [
      { slug: 'OK-slug', name: '良い', lastUsedAt: 'not-a-date' }, // lastUsedAt invalid
      { slug: 'INVALID UPPER', name: 'X', lastUsedAt: new Date().toISOString() }, // slug pattern fail
      { slug: 'ok', name: '', lastUsedAt: new Date().toISOString() }, // name empty
      { slug: 'good', name: 'Good Org', lastUsedAt: new Date().toISOString() }, // valid
    ];
    mockStorage.setItem(STORAGE_KEY, JSON.stringify(corrupt));
    const r = getTenantHistory();
    expect(r).toHaveLength(1);
    expect(r[0].slug).toBe('good');
  });

  it('90 日以上前のエントリは expire 扱いで除去される', () => {
    const old = new Date();
    old.setDate(old.getDate() - 91);
    const fresh = new Date();
    const entries: TenantHistoryEntry[] = [
      { slug: 'old-one', name: '古い組織', lastUsedAt: old.toISOString() },
      { slug: 'fresh', name: '新しい組織', lastUsedAt: fresh.toISOString() },
    ];
    mockStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
    const r = getTenantHistory();
    expect(r).toHaveLength(1);
    expect(r[0].slug).toBe('fresh');
  });

  it('未来日時 (1 分以上先) のエントリは無効扱い', () => {
    const future = new Date();
    future.setMinutes(future.getMinutes() + 10);
    const entries = [{ slug: 'futuristic', name: '未来', lastUsedAt: future.toISOString() }];
    mockStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
    expect(getTenantHistory()).toEqual([]);
  });
});

describe('tenant-history.recordTenantUsage', () => {
  it('新規追加: 1 件記録される', () => {
    recordTenantUsage('acme', 'Acme Corp');
    const r = getTenantHistory();
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ slug: 'acme', name: 'Acme Corp' });
  });

  it('同じ slug を再記録すると lastUsedAt 更新 + 先頭に移動 (LRU)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-21T10:00:00Z'));
    recordTenantUsage('first', '一番目');
    vi.setSystemTime(new Date('2026-05-21T11:00:00Z'));
    recordTenantUsage('second', '二番目');
    vi.setSystemTime(new Date('2026-05-21T12:00:00Z'));
    recordTenantUsage('first', '一番目'); // 再使用 → 先頭に上がる

    const r = getTenantHistory();
    expect(r.map((e) => e.slug)).toEqual(['first', 'second']);
    expect(r[0].lastUsedAt).toBe('2026-05-21T12:00:00.000Z');
  });

  it('上限 5 件を超えると古いものから捨てられる', () => {
    for (let i = 0; i < 7; i++) {
      recordTenantUsage(`org-${i}`, `Org ${i}`);
    }
    const r = getTenantHistory();
    expect(r).toHaveLength(5);
    // 最新が先頭、最古 2 件 (org-0, org-1) は捨てられている
    expect(r[0].slug).toBe('org-6');
    expect(r.find((e) => e.slug === 'org-0')).toBeUndefined();
    expect(r.find((e) => e.slug === 'org-1')).toBeUndefined();
  });

  it('slug pattern 不正のものは no-op (大文字 / 空白 / 長すぎ)', () => {
    recordTenantUsage('UPPER-CASE', 'X');
    recordTenantUsage('has space', 'X');
    recordTenantUsage('a'.repeat(64), 'X'); // 64 chars (>63)
    expect(getTenantHistory()).toHaveLength(0);
  });

  it('name 異常に長い場合は 100 文字に truncate', () => {
    const longName = 'あ'.repeat(200);
    recordTenantUsage('ok', longName);
    const r = getTenantHistory();
    expect(r[0].name.length).toBe(100);
  });
});

describe('tenant-history.removeTenantFromHistory', () => {
  it('指定 slug だけ削除', () => {
    recordTenantUsage('a', 'A');
    recordTenantUsage('b', 'B');
    recordTenantUsage('c', 'C');
    removeTenantFromHistory('b');
    expect(getTenantHistory().map((e) => e.slug)).toEqual(['c', 'a']);
  });

  it('存在しない slug は no-op', () => {
    recordTenantUsage('a', 'A');
    removeTenantFromHistory('nonexistent');
    expect(getTenantHistory()).toHaveLength(1);
  });
});

describe('tenant-history.clearTenantHistory', () => {
  it('全エントリを削除', () => {
    recordTenantUsage('a', 'A');
    recordTenantUsage('b', 'B');
    clearTenantHistory();
    expect(getTenantHistory()).toEqual([]);
    expect(mockStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});

describe('tenant-history: SSR / window 不在環境', () => {
  it('window 不在でも throw せず no-op', () => {
    vi.stubGlobal('window', undefined);
    expect(getTenantHistory()).toEqual([]);
    expect(() => recordTenantUsage('a', 'A')).not.toThrow();
    expect(() => clearTenantHistory()).not.toThrow();
  });
});
