/**
 * url-builder.ts のテスト (ADR-0016 / 2026-05-20)
 */

import { describe, it, expect } from 'vitest';
import {
  buildLoginUrl,
  buildSetupPasswordUrl,
  buildResetPasswordUrl,
  buildLockStatusUrl,
} from './url-builder';

const BASE_URL = 'https://tasukiba.netlify.app';

describe('url-builder', () => {
  describe('buildLoginUrl', () => {
    it('tenantSlug を query パラメタに含む', () => {
      expect(buildLoginUrl('acme-corp', BASE_URL)).toBe(
        'https://tasukiba.netlify.app/login?tenant=acme-corp',
      );
    });

    it('特殊文字を含む slug を URL エンコード', () => {
      expect(buildLoginUrl('test slug', BASE_URL)).toContain('tenant=test%20slug');
    });
  });

  describe('buildSetupPasswordUrl', () => {
    it('tenant + token を含む', () => {
      const url = buildSetupPasswordUrl('acme-corp', 'tok123', BASE_URL);
      expect(url).toContain('tenant=acme-corp');
      expect(url).toContain('token=tok123');
      expect(url).toMatch(/^https:\/\/tasukiba\.netlify\.app\/setup-password\?/);
    });
  });

  describe('buildResetPasswordUrl', () => {
    it('tenant + token を含む', () => {
      const url = buildResetPasswordUrl('acme-corp', 'tok456', BASE_URL);
      expect(url).toContain('tenant=acme-corp');
      expect(url).toContain('token=tok456');
      expect(url).toMatch(/^https:\/\/tasukiba\.netlify\.app\/reset-password\?/);
    });
  });

  describe('buildLockStatusUrl', () => {
    it('tenantSlug を query に含む', () => {
      expect(buildLockStatusUrl('acme-corp', BASE_URL)).toBe(
        'https://tasukiba.netlify.app/lock-status?tenant=acme-corp',
      );
    });
  });
});
