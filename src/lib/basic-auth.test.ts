/**
 * basic-auth.ts の単体テスト (PR-V7 / 2026-05-19)
 *
 * 検証観点:
 *   1. verifyBasicAuth: 正常一致 / ヘッダ無 / 形式不正 / 文字数不一致 / 1 文字違い
 *   2. constant-time 比較が機能している (= 長さが違っても同じ false で返却)
 *   3. getAdminSuperBasicAuthConfig: enabled/disabled/misconfigured の 3 パターン
 *   4. buildBasicAuthChallenge: 401 + WWW-Authenticate ヘッダ
 */

import { describe, it, expect } from 'vitest';
import {
  verifyBasicAuth,
  getAdminSuperBasicAuthConfig,
  buildBasicAuthChallenge,
} from './basic-auth';

const USER = 'admin';
const PASS = 'super-secret-password-32chars-OKxx';
const VALID_HEADER = `Basic ${btoa(`${USER}:${PASS}`)}`;

describe('verifyBasicAuth', () => {
  it('正常な認証ヘッダ → true', () => {
    expect(verifyBasicAuth(VALID_HEADER, USER, PASS)).toBe(true);
  });

  it('Authorization ヘッダなし (null) → false', () => {
    expect(verifyBasicAuth(null, USER, PASS)).toBe(false);
  });

  it('Authorization ヘッダなし (undefined) → false', () => {
    expect(verifyBasicAuth(undefined, USER, PASS)).toBe(false);
  });

  it('空文字 → false', () => {
    expect(verifyBasicAuth('', USER, PASS)).toBe(false);
  });

  it('"Basic " プレフィックスなし → false', () => {
    expect(verifyBasicAuth('Bearer xxx', USER, PASS)).toBe(false);
    expect(verifyBasicAuth(btoa(`${USER}:${PASS}`), USER, PASS)).toBe(false);
  });

  it('正しい形式だが credential 違い → false', () => {
    const wrong = `Basic ${btoa(`${USER}:wrong-password-1234567890123456789`)}`;
    expect(verifyBasicAuth(wrong, USER, PASS)).toBe(false);
  });

  it('1 文字だけ違う → false (= constant-time 比較で検知)', () => {
    const almost = `Basic ${btoa(`${USER}:${PASS.slice(0, -1)}X`)}`;
    expect(verifyBasicAuth(almost, USER, PASS)).toBe(false);
  });

  it('ユーザ名違い → false', () => {
    const wrong = `Basic ${btoa(`wronguser:${PASS}`)}`;
    expect(verifyBasicAuth(wrong, USER, PASS)).toBe(false);
  });

  it('長さが違う credential → false (= 早期 return で安全)', () => {
    const shorter = `Basic ${btoa(`${USER}:short`)}`;
    expect(verifyBasicAuth(shorter, USER, PASS)).toBe(false);
  });
});

describe('getAdminSuperBasicAuthConfig', () => {
  it('USER + PASS 両方 set → enabled: true', () => {
    const result = getAdminSuperBasicAuthConfig({
      ADMIN_SUPER_BASIC_AUTH_USER: 'admin',
      ADMIN_SUPER_BASIC_AUTH_PASS: 'secret',
    } as unknown as NodeJS.ProcessEnv);
    expect(result.enabled).toBe(true);
    if (result.enabled) {
      expect(result.user).toBe('admin');
      expect(result.pass).toBe('secret');
    }
  });

  it('両方 unset → enabled: false (= 開発/E2E モード)', () => {
    const result = getAdminSuperBasicAuthConfig({} as unknown as NodeJS.ProcessEnv);
    expect(result.enabled).toBe(false);
  });

  it('USER のみ set / PASS 未設定 → enabled: true + fail-closed の値', () => {
    const result = getAdminSuperBasicAuthConfig({
      ADMIN_SUPER_BASIC_AUTH_USER: 'admin',
    } as unknown as NodeJS.ProcessEnv);
    expect(result.enabled).toBe(true);
    if (result.enabled) {
      // 誰も推測できない fail-closed 値が入る
      expect(result.user).toContain('MISCONFIGURED');
      expect(result.pass).toContain('MISCONFIGURED');
    }
  });

  it('PASS のみ set / USER 未設定 → enabled: true + fail-closed の値', () => {
    const result = getAdminSuperBasicAuthConfig({
      ADMIN_SUPER_BASIC_AUTH_PASS: 'secret',
    } as unknown as NodeJS.ProcessEnv);
    expect(result.enabled).toBe(true);
    if (result.enabled) {
      expect(result.user).toContain('MISCONFIGURED');
      expect(result.pass).toContain('MISCONFIGURED');
    }
  });

  it('fail-closed の値で verifyBasicAuth は絶対に通らない (= 正しいパスワード推測の手段が無い)', () => {
    const config = getAdminSuperBasicAuthConfig({
      ADMIN_SUPER_BASIC_AUTH_USER: 'admin',
    } as unknown as NodeJS.ProcessEnv);
    if (!config.enabled) throw new Error('expected enabled');
    // 正規 USER + PASS で試みても通らない
    const correctHeader = `Basic ${btoa('admin:any-password')}`;
    expect(verifyBasicAuth(correctHeader, config.user, config.pass)).toBe(false);
  });
});

describe('buildBasicAuthChallenge', () => {
  it('401 + WWW-Authenticate Basic realm ヘッダを返却', async () => {
    const res = buildBasicAuthChallenge();
    expect(res.status).toBe(401);
    const wwwAuth = res.headers.get('WWW-Authenticate');
    expect(wwwAuth).toContain('Basic realm=');
    expect(wwwAuth).toContain('"Super Admin Area"');
    expect(wwwAuth).toContain('charset="UTF-8"');
  });

  it('realm 引数で表示名カスタマイズ可', () => {
    const res = buildBasicAuthChallenge('Custom Realm');
    expect(res.headers.get('WWW-Authenticate')).toContain('"Custom Realm"');
  });
});
