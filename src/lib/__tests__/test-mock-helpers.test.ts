import { describe, expect, it, vi } from 'vitest';
import { getMockCallArg } from '../test-mock-helpers';

describe('getMockCallArg', () => {
  it('1 回呼ばれた mock の第 0 引数を返す', () => {
    const m = vi.fn((_args: { where: { tenantId: string } }) => undefined);
    m({ where: { tenantId: 't-1' } });
    const arg = getMockCallArg(m);
    expect(arg.where.tenantId).toBe('t-1');
  });

  it('未呼出の mock では throw', () => {
    const m = vi.fn((_args: { where: { tenantId: string } }) => undefined);
    expect(() => getMockCallArg(m)).toThrow(/expected call at index 0/);
  });

  it('callIdx 指定で 2 回目の呼出を取得', () => {
    const m = vi.fn((_args: { id: string }) => undefined);
    m({ id: 'a' });
    m({ id: 'b' });
    expect(getMockCallArg(m, 1).id).toBe('b');
  });
});
