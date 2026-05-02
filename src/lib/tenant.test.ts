import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  DEFAULT_TENANT_ID,
  DEFAULT_TENANT_SLUG,
  TENANT_PLANS,
  isTenantPlan,
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

    it('schema.prisma の DB DEFAULT も同 UUID を参照している', () => {
      const schemaPath = path.resolve(__dirname, '../../prisma/schema.prisma');
      const schema = readFileSync(schemaPath, 'utf-8');

      // DEFAULT 句で参照される UUID リテラルをすべて抽出
      const dbDefaultMatches = [...schema.matchAll(/'([0-9a-f-]{36})'::uuid/g)];

      expect(
        dbDefaultMatches.length,
        'schema.prisma に dbgenerated の UUID DEFAULT が存在する',
      ).toBeGreaterThan(0);

      // すべての DEFAULT が DEFAULT_TENANT_ID と一致する
      for (const m of dbDefaultMatches) {
        expect(m[1]).toBe(DEFAULT_TENANT_ID);
      }
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
});
