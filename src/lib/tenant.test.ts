import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  DEFAULT_TENANT_ID,
  DEFAULT_TENANT_SLUG,
  TENANT_PLANS,
  isTenantPlan,
  MANAGEMENT_TENANT_ID,
  MANAGEMENT_TENANT_SLUG,
  isManagementTenant,
} from './tenant';

describe('tenant constants', () => {
  describe('DEFAULT_TENANT_ID', () => {
    it('UUID v4 形式の固定値である', () => {
      // RFC 4122 の UUID 形式 (small-case 8-4-4-4-12 hex)
      expect(DEFAULT_TENANT_ID).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });

    it('migration SQL 内の INSERT 文の UUID と完全一致する (両者の同期は必須)', () => {
      // schema.prisma の DB DEFAULT も同じ UUID を参照しているため、
      // ここでズレると DB が外部キー制約違反で動かなくなる。
      const migrationPath = path.resolve(
        __dirname,
        '../../prisma/migrations/20260502_multi_tenant_base/migration.sql',
      );
      const sql = readFileSync(migrationPath, 'utf-8');

      // INSERT INTO "tenants" の VALUES 第一要素 (id) を抽出
      const insertMatch = sql.match(
        /INSERT INTO "tenants"[^(]*\([^)]+\)\s*VALUES\s*\(\s*'([^']+)'/,
      );
      expect(insertMatch, 'migration SQL に default-tenant の INSERT 文が存在する').toBeTruthy();
      expect(insertMatch?.[1]).toBe(DEFAULT_TENANT_ID);
    });

    // ★severity-1 regression (ADR-0024 / fix/tenant-id-default-removal, 2026-05-28):
    //   旧仕様 (~2026-05-28): schema の各 tenantId に `@default(dbgenerated tenantId)` を付与し
    //     コードが渡し忘れたら DB DEFAULT で Default テナントに silent 配属していた。
    //   → severity-1 セキュリティバグ (個人情報漏洩リスク) の温床だったため ADR-0024 で撤去。
    //   新仕様: schema から DB DEFAULT を完全撤去。コードが必ず明示的に tenantId を渡し、
    //     未指定なら NOT NULL 違反で loud fail させる設計。
    //   本テストは「schema に dbgenerated UUID DEFAULT が **存在しない**」ことを保証し、
    //     将来の不用意な再導入 (= severity-1 バグ再発) を防ぐガード。
    it('★severity-1 regression: schema.prisma に dbgenerated UUID DEFAULT が存在しない (ADR-0024)', () => {
      const schemaPath = path.resolve(__dirname, '../../prisma/schema.prisma');
      const schema = readFileSync(schemaPath, 'utf-8');

      // `@default(dbgenerated("'00000000-...-001'::uuid"))` 形式の UUID DEFAULT を grep。
      // gen_random_uuid() (id カラム用) は対象外。
      const dbDefaultUuidMatches = [
        ...schema.matchAll(/@default\(dbgenerated\("'([0-9a-f-]{36})'::uuid"\)\)/g),
      ];

      expect(
        dbDefaultUuidMatches.length,
        '★severity-1: schema.prisma に dbgenerated UUID DEFAULT が再導入されています。' +
          'ADR-0024 の決定に反するため必ず撤去してください (Default テナント silent 混入の温床)。' +
          `見つかった箇所: ${dbDefaultUuidMatches.map((m) => m[0]).join(', ')}`,
      ).toBe(0);
    });
  });

  describe('DEFAULT_TENANT_SLUG', () => {
    it('"default" 固定値である', () => {
      expect(DEFAULT_TENANT_SLUG).toBe('default');
    });
  });

  describe('TENANT_PLANS / isTenantPlan', () => {
    it('3 プラン構成: beginner / expert / pro', () => {
      expect(TENANT_PLANS).toEqual(['beginner', 'expert', 'pro']);
    });

    it('isTenantPlan は有効プランを true で判定する', () => {
      expect(isTenantPlan('beginner')).toBe(true);
      expect(isTenantPlan('expert')).toBe(true);
      expect(isTenantPlan('pro')).toBe(true);
    });

    it('isTenantPlan は無効値を false で判定する (不正入力ガード)', () => {
      expect(isTenantPlan('free')).toBe(false);
      expect(isTenantPlan('premium')).toBe(false);
      expect(isTenantPlan('')).toBe(false);
      expect(isTenantPlan(null)).toBe(false);
      expect(isTenantPlan(undefined)).toBe(false);
      expect(isTenantPlan(123)).toBe(false);
      expect(isTenantPlan({})).toBe(false);
    });
  });

  // PR-X1 (2026-05-07): 管理テナント関連
  describe('MANAGEMENT_TENANT_ID / isManagementTenant', () => {
    it('管理テナントの UUID は default-tenant と異なる固定値', () => {
      expect(MANAGEMENT_TENANT_ID).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(MANAGEMENT_TENANT_ID).not.toBe(DEFAULT_TENANT_ID);
    });

    it('管理テナント slug は "platform-admin"', () => {
      expect(MANAGEMENT_TENANT_SLUG).toBe('platform-admin');
    });

    it('isManagementTenant: 管理テナント ID で true', () => {
      expect(isManagementTenant(MANAGEMENT_TENANT_ID)).toBe(true);
    });

    it('isManagementTenant: default-tenant ID で false', () => {
      expect(isManagementTenant(DEFAULT_TENANT_ID)).toBe(false);
    });

    it('isManagementTenant: 任意の他 UUID で false', () => {
      expect(isManagementTenant('11111111-1111-1111-1111-111111111111')).toBe(false);
      expect(isManagementTenant('')).toBe(false);
    });
  });
});
