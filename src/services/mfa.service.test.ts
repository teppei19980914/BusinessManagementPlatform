import { describe, it, expect } from 'vitest';

describe('TOTP (otplib)', () => {
  it('シークレット生成・検証ができる', async () => {
    const otplib = await import('otplib');
    const secret = otplib.generateSecret();
    expect(secret).toBeDefined();

    const token = otplib.generateSync({ secret });
    expect(token).toHaveLength(6);

    const result = otplib.verifySync({ token, secret });
    expect(result.valid).toBe(true);
  });

  it('不正なコードで検証が失敗する', async () => {
    const otplib = await import('otplib');
    const secret = otplib.generateSecret();
    const result = otplib.verifySync({ token: '000000', secret });
    expect(result.valid).toBe(false);
  });

  it('otpauth URI が生成できる', async () => {
    const otplib = await import('otplib');
    const secret = otplib.generateSecret();
    const uri = otplib.generateURI({
      label: 'test@example.com',
      issuer: 'TestApp',
      secret,
    });
    expect(uri).toContain('otpauth://totp/');
  });
});
