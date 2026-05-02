import { describe, expect, it } from 'vitest';

import {
  resolveTenantBySlug,
  resolveDefaultTenantId,
} from './tenant-routing';
import { DEFAULT_TENANT_ID, DEFAULT_TENANT_SLUG } from './tenant';

describe('resolveTenantBySlug', () => {
  it('default slug → DEFAULT_TENANT_ID を返す', () => {
    expect(resolveTenantBySlug('default')).toBe(DEFAULT_TENANT_ID);
  });

  it('DEFAULT_TENANT_SLUG 定数経由でも同じ結果', () => {
    expect(resolveTenantBySlug(DEFAULT_TENANT_SLUG)).toBe(DEFAULT_TENANT_ID);
  });

  it('未登録 slug は null を返す (404 経路)', () => {
    expect(resolveTenantBySlug('acme')).toBeNull();
    expect(resolveTenantBySlug('xyz')).toBeNull();
  });

  it('空文字列も null', () => {
    expect(resolveTenantBySlug('')).toBeNull();
  });

  it('case-sensitive: "Default" は未登録扱い (slug 規約は lower-case)', () => {
    expect(resolveTenantBySlug('Default')).toBeNull();
    expect(resolveTenantBySlug('DEFAULT')).toBeNull();
  });
});

describe('resolveDefaultTenantId', () => {
  it('DEFAULT_TENANT_ID と完全一致を返す', () => {
    expect(resolveDefaultTenantId()).toBe(DEFAULT_TENANT_ID);
  });

  it('UUID v4 形式である (DB FK と整合)', () => {
    expect(resolveDefaultTenantId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});
