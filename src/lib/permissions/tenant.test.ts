import { describe, expect, it } from 'vitest';

import {
  TenantBoundaryError,
  requireAllSameTenant,
  requireSameTenant,
  tenantScope,
} from './tenant';
import { DEFAULT_TENANT_ID } from '@/lib/tenant';

const TENANT_A = '11111111-1111-1111-1111-111111111111';
const TENANT_B = '22222222-2222-2222-2222-222222222222';

describe('TenantBoundaryError', () => {
  it('userTenantId と entityTenantId をプロパティで保持する', () => {
    const err = new TenantBoundaryError(TENANT_A, TENANT_B);
    expect(err.userTenantId).toBe(TENANT_A);
    expect(err.entityTenantId).toBe(TENANT_B);
  });

  it('Error のサブクラスで instanceof で判別可能', () => {
    const err = new TenantBoundaryError(TENANT_A, TENANT_B);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(TenantBoundaryError);
    expect(err.name).toBe('TenantBoundaryError');
  });

  it('メッセージに両 tenantId を含む (調査ログで原因特定可能)', () => {
    const err = new TenantBoundaryError(TENANT_A, TENANT_B);
    expect(err.message).toContain(TENANT_A);
    expect(err.message).toContain(TENANT_B);
  });
});

describe('requireSameTenant', () => {
  it('tenantId が一致するエンティティでは何も投げない', () => {
    expect(() =>
      requireSameTenant(TENANT_A, { tenantId: TENANT_A }),
    ).not.toThrow();
  });

  it('tenantId が不一致のエンティティでは TenantBoundaryError を投げる', () => {
    expect(() =>
      requireSameTenant(TENANT_A, { tenantId: TENANT_B }),
    ).toThrow(TenantBoundaryError);
  });

  it('null エンティティは検証スキップ (404 経路で扱うため)', () => {
    expect(() => requireSameTenant(TENANT_A, null)).not.toThrow();
  });

  it('undefined エンティティは検証スキップ (404 経路で扱うため)', () => {
    expect(() => requireSameTenant(TENANT_A, undefined)).not.toThrow();
  });

  it('追加プロパティを持つ型でも tenantId だけ見て判定する (構造的部分型)', () => {
    type Project = { id: string; tenantId: string; name: string };
    const p: Project = { id: 'p1', tenantId: TENANT_A, name: 'foo' };
    expect(() => requireSameTenant(TENANT_A, p)).not.toThrow();
  });

  it('default-tenant でも仕組みが機能する (v1 単一テナント運用の境界保証)', () => {
    expect(() =>
      requireSameTenant(DEFAULT_TENANT_ID, { tenantId: DEFAULT_TENANT_ID }),
    ).not.toThrow();
    expect(() =>
      requireSameTenant(DEFAULT_TENANT_ID, { tenantId: TENANT_A }),
    ).toThrow(TenantBoundaryError);
  });
});

describe('requireAllSameTenant', () => {
  it('全エンティティが同テナントなら何も投げない', () => {
    expect(() =>
      requireAllSameTenant(TENANT_A, [
        { tenantId: TENANT_A },
        { tenantId: TENANT_A },
        { tenantId: TENANT_A },
      ]),
    ).not.toThrow();
  });

  it('1 つでも別テナントが混ざれば TenantBoundaryError を投げる', () => {
    expect(() =>
      requireAllSameTenant(TENANT_A, [
        { tenantId: TENANT_A },
        { tenantId: TENANT_B },
        { tenantId: TENANT_A },
      ]),
    ).toThrow(TenantBoundaryError);
  });

  it('空配列は何も投げない', () => {
    expect(() => requireAllSameTenant(TENANT_A, [])).not.toThrow();
  });

  it('null / undefined を含む配列でも実体のみ検証する', () => {
    expect(() =>
      requireAllSameTenant(TENANT_A, [
        { tenantId: TENANT_A },
        null,
        undefined,
        { tenantId: TENANT_A },
      ]),
    ).not.toThrow();
  });

  it('最初の不一致で停止する (後続の不一致まで列挙しない)', () => {
    // 第 2 要素で投げ、第 3 要素は検証されない (副作用なし)
    let inspected = 0;
    const proxy = (tid: string) =>
      new Proxy(
        { tenantId: tid },
        {
          get(target, prop) {
            inspected += 1;
            return target[prop as 'tenantId'];
          },
        },
      ) as { tenantId: string };

    expect(() =>
      requireAllSameTenant(TENANT_A, [
        proxy(TENANT_A),
        proxy(TENANT_B),
        proxy(TENANT_A),
      ]),
    ).toThrow(TenantBoundaryError);
    // 最初の 2 件のみ inspect された (3 件目には到達しない)
    expect(inspected).toBe(2);
  });
});

describe('tenantScope', () => {
  it('Prisma where 節として展開可能なオブジェクトを返す', () => {
    expect(tenantScope(TENANT_A)).toEqual({ tenantId: TENANT_A });
  });

  it('スプレッド演算子で他の where 条件と合成可能', () => {
    const where = {
      ...tenantScope(TENANT_A),
      status: 'in_progress',
      deletedAt: null,
    };
    expect(where).toEqual({
      tenantId: TENANT_A,
      status: 'in_progress',
      deletedAt: null,
    });
  });

  it('default-tenant でも正しく展開される', () => {
    expect(tenantScope(DEFAULT_TENANT_ID)).toEqual({
      tenantId: DEFAULT_TENANT_ID,
    });
  });
});

describe('境界統合: tenantScope + requireSameTenant の二重防御', () => {
  // 設計書通り、where に tenantScope を入れた上で結果を requireSameTenant で再検証する
  // 二重防御パターンが正しく機能することを示すシナリオテスト
  it('正常系: 同テナントの SELECT 結果を再検証してパス', () => {
    const userTenantId = TENANT_A;
    // DB が tenantScope で正しく絞り込んだ仮定
    const fakeRows = [
      { id: 'p1', tenantId: TENANT_A, name: 'Project 1' },
      { id: 'p2', tenantId: TENANT_A, name: 'Project 2' },
    ];
    expect(() =>
      requireAllSameTenant(userTenantId, fakeRows),
    ).not.toThrow();
  });

  it('異常系: DB 側の絞り込み漏れがあった場合に検出する (保険機能)', () => {
    const userTenantId = TENANT_A;
    // 仮に DB クエリで where 漏れがあり、別テナントのデータが返ってきた状況を想定
    const leakedRows = [
      { id: 'p1', tenantId: TENANT_A, name: 'Project 1' },
      { id: 'leak', tenantId: TENANT_B, name: 'Leaked Project' }, // 本来見えないはず
    ];
    expect(() =>
      requireAllSameTenant(userTenantId, leakedRows),
    ).toThrow(TenantBoundaryError);
  });
});
