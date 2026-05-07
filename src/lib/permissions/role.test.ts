/**
 * src/lib/permissions/role.ts の単体テスト (PR-X1 / 2026-05-07)
 *
 * 検証項目:
 *   - isSuperAdmin / isTenantAdmin / isAdminOrAbove の境界値判定
 *   - requireSuperAdmin の throw 挙動
 *   - 既存の admin / general 値が「テナント管理者 / 一般」として正しく動作する
 *     (= ROLE_REFACTORING_PLAN.md §2.1 の意味再解釈と整合)
 */

import { describe, it, expect } from 'vitest';
import {
  isSuperAdmin,
  isTenantAdmin,
  isAdminOrAbove,
  requireSuperAdmin,
} from './role';

describe('isSuperAdmin', () => {
  it('systemRole が super_admin なら true', () => {
    expect(isSuperAdmin({ systemRole: 'super_admin' })).toBe(true);
  });

  it('admin / general / 不明値はすべて false', () => {
    expect(isSuperAdmin({ systemRole: 'admin' })).toBe(false);
    expect(isSuperAdmin({ systemRole: 'general' })).toBe(false);
    expect(isSuperAdmin({ systemRole: 'unknown' })).toBe(false);
    expect(isSuperAdmin({ systemRole: '' })).toBe(false);
  });
});

describe('isTenantAdmin', () => {
  it('systemRole が admin なら true (= テナント管理者)', () => {
    expect(isTenantAdmin({ systemRole: 'admin' })).toBe(true);
  });

  it('super_admin は admin ではないので false (= 厳密な判定)', () => {
    // ROLE_REFACTORING_PLAN.md §2.2: super_admin は自テナント内で admin 相当だが、
    // isTenantAdmin は「テナント管理者専用」の機能で使う厳密判定 (例: 自テナント設定)
    expect(isTenantAdmin({ systemRole: 'super_admin' })).toBe(false);
  });

  it('general / 不明値は false', () => {
    expect(isTenantAdmin({ systemRole: 'general' })).toBe(false);
    expect(isTenantAdmin({ systemRole: 'unknown' })).toBe(false);
  });
});

describe('isAdminOrAbove', () => {
  it('admin は true', () => {
    expect(isAdminOrAbove({ systemRole: 'admin' })).toBe(true);
  });

  it('super_admin は true', () => {
    expect(isAdminOrAbove({ systemRole: 'super_admin' })).toBe(true);
  });

  it('general / 不明値は false', () => {
    expect(isAdminOrAbove({ systemRole: 'general' })).toBe(false);
    expect(isAdminOrAbove({ systemRole: 'unknown' })).toBe(false);
  });
});

describe('requireSuperAdmin', () => {
  it('super_admin なら何もせず通過', () => {
    expect(() => requireSuperAdmin({ systemRole: 'super_admin' })).not.toThrow();
  });

  it('super_admin でなければ FORBIDDEN を throw', () => {
    expect(() => requireSuperAdmin({ systemRole: 'admin' })).toThrow(/FORBIDDEN/);
    expect(() => requireSuperAdmin({ systemRole: 'general' })).toThrow(/FORBIDDEN/);
  });
});

describe('意味再解釈の互換性確認 (ROLE_REFACTORING_PLAN.md §2.1)', () => {
  it('既存の admin 値は引き続き「テナント管理者」として扱われる', () => {
    const tenantAdmin = { systemRole: 'admin' };
    // テナント管理者は admin 系判定で true、super_admin 系判定で false が期待値
    expect(isTenantAdmin(tenantAdmin)).toBe(true);
    expect(isAdminOrAbove(tenantAdmin)).toBe(true);
    expect(isSuperAdmin(tenantAdmin)).toBe(false);
  });

  it('既存の general 値は引き続き「一般ユーザ」として扱われる', () => {
    const general = { systemRole: 'general' };
    expect(isTenantAdmin(general)).toBe(false);
    expect(isAdminOrAbove(general)).toBe(false);
    expect(isSuperAdmin(general)).toBe(false);
  });

  it('新規の super_admin は admin 系も true、super_admin 系も true', () => {
    const superAdmin = { systemRole: 'super_admin' };
    expect(isAdminOrAbove(superAdmin)).toBe(true);
    expect(isSuperAdmin(superAdmin)).toBe(true);
    expect(isTenantAdmin(superAdmin)).toBe(false); // 厳密 admin (= テナント管理者) ではない
  });
});
