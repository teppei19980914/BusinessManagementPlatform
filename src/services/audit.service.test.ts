import { describe, it, expect } from 'vitest';
import { sanitizeForAudit } from './audit.service';

describe('sanitizeForAudit', () => {
  it('passwordHash を [REDACTED] に置換する', () => {
    const result = sanitizeForAudit({
      id: '123',
      name: 'test',
      passwordHash: '$2a$12$xxxxx',
    });
    expect(result.passwordHash).toBe('[REDACTED]');
    expect(result.id).toBe('123');
    expect(result.name).toBe('test');
  });

  it('password_hash（スネークケース）も [REDACTED] に置換する', () => {
    const result = sanitizeForAudit({
      id: '123',
      password_hash: '$2a$12$xxxxx',
    });
    expect(result.password_hash).toBe('[REDACTED]');
  });

  it('mfaSecretEncrypted を [REDACTED] に置換する', () => {
    const result = sanitizeForAudit({
      id: '123',
      mfaSecretEncrypted: 'encrypted-secret',
    });
    expect(result.mfaSecretEncrypted).toBe('[REDACTED]');
  });

  it('mfa_secret_encrypted（スネークケース）も [REDACTED] に置換する', () => {
    const result = sanitizeForAudit({
      id: '123',
      mfa_secret_encrypted: 'encrypted-secret',
    });
    expect(result.mfa_secret_encrypted).toBe('[REDACTED]');
  });

  it('機密フィールドがない場合はそのまま返す', () => {
    const input = { id: '123', name: 'test', email: 'test@example.com' };
    const result = sanitizeForAudit(input);
    expect(result).toEqual(input);
  });

  it('空のオブジェクトを処理できる', () => {
    const result = sanitizeForAudit({});
    expect(result).toEqual({});
  });

  it('元のオブジェクトを変更しない', () => {
    const input = { id: '123', passwordHash: 'secret' };
    sanitizeForAudit(input);
    expect(input.passwordHash).toBe('secret');
  });
});
