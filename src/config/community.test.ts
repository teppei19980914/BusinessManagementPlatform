import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  DEFAULT_DISCORD_INVITE_URL,
  PRODUCT_LP_URL,
  getDiscordInviteUrl,
  getFeatureRequestUrl,
} from './community';

/**
 * PR I (2026-05-09): community link helpers の挙動検証。
 *
 * カバー範囲:
 *   - DEFAULT_DISCORD_INVITE_URL は公開リンクとして妥当な URL
 *   - getDiscordInviteUrl: env 未設定 → デフォルト、env 設定 → 上書き、'disabled' → null
 *   - getFeatureRequestUrl: env 未設定 → null (UI 側で fallback)、env 設定 → そのまま
 *   - PRODUCT_LP_URL は固定の HomePage URL
 */

describe('community.ts', () => {
  let originalDiscord: string | undefined;
  let originalFeatureRequest: string | undefined;

  beforeEach(() => {
    originalDiscord = process.env.NEXT_PUBLIC_DISCORD_INVITE_URL;
    originalFeatureRequest = process.env.NEXT_PUBLIC_FEATURE_REQUEST_URL;
  });

  afterEach(() => {
    if (originalDiscord === undefined) {
      delete process.env.NEXT_PUBLIC_DISCORD_INVITE_URL;
    } else {
      process.env.NEXT_PUBLIC_DISCORD_INVITE_URL = originalDiscord;
    }
    if (originalFeatureRequest === undefined) {
      delete process.env.NEXT_PUBLIC_FEATURE_REQUEST_URL;
    } else {
      process.env.NEXT_PUBLIC_FEATURE_REQUEST_URL = originalFeatureRequest;
    }
  });

  describe('DEFAULT_DISCORD_INVITE_URL', () => {
    it('Discord の招待ドメインで始まる', () => {
      expect(DEFAULT_DISCORD_INVITE_URL).toMatch(/^https:\/\/discord\.(com|gg)\//);
    });
  });

  describe('PRODUCT_LP_URL', () => {
    it('https で始まり tasukiba を含む', () => {
      expect(PRODUCT_LP_URL).toMatch(/^https:\/\//);
      expect(PRODUCT_LP_URL).toContain('tasukiba');
    });
  });

  describe('getDiscordInviteUrl()', () => {
    it('env 未設定なら DEFAULT_DISCORD_INVITE_URL を返す', () => {
      delete process.env.NEXT_PUBLIC_DISCORD_INVITE_URL;
      expect(getDiscordInviteUrl()).toBe(DEFAULT_DISCORD_INVITE_URL);
    });

    it('env が空文字なら DEFAULT_DISCORD_INVITE_URL を返す', () => {
      process.env.NEXT_PUBLIC_DISCORD_INVITE_URL = '';
      expect(getDiscordInviteUrl()).toBe(DEFAULT_DISCORD_INVITE_URL);
    });

    it('env が指定されていればそちらを返す (上書き)', () => {
      process.env.NEXT_PUBLIC_DISCORD_INVITE_URL = 'https://discord.gg/custom';
      expect(getDiscordInviteUrl()).toBe('https://discord.gg/custom');
    });

    it('env が "disabled" なら null (UI 非表示にしたい場合のスイッチ)', () => {
      process.env.NEXT_PUBLIC_DISCORD_INVITE_URL = 'disabled';
      expect(getDiscordInviteUrl()).toBeNull();
    });
  });

  describe('getFeatureRequestUrl()', () => {
    it('env 未設定なら null を返す (一般 Discord にフォールバックする運用)', () => {
      delete process.env.NEXT_PUBLIC_FEATURE_REQUEST_URL;
      expect(getFeatureRequestUrl()).toBeNull();
    });

    it('env が空文字なら null', () => {
      process.env.NEXT_PUBLIC_FEATURE_REQUEST_URL = '   ';
      expect(getFeatureRequestUrl()).toBeNull();
    });

    it('env が指定されていればそのまま返す', () => {
      process.env.NEXT_PUBLIC_FEATURE_REQUEST_URL = 'https://discord.com/forum/abc';
      expect(getFeatureRequestUrl()).toBe('https://discord.com/forum/abc');
    });
  });
});
