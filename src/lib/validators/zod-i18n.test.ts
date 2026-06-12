import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';

vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn(async (namespace: string) => {
    if (namespace !== 'validation') return (k: string) => `${namespace}.${k}`;
    const map: Record<string, string> = {
      invalidType: 'Invalid value type (expected {expected})',
      tooSmall: 'Must be {min} or greater',
      tooBig: 'Must be {max} or less',
      invalidFormat: 'Invalid format ({format})',
      custom: 'The input contains invalid values',
    };
    return (key: string, params?: Record<string, string | number>) => {
      let v = map[key] ?? `validation.${key}`;
      if (params) for (const [k, val] of Object.entries(params)) v = v.replace(`{${k}}`, String(val));
      return v;
    };
  }),
}));

import { translateZodIssues, parseOrThrowAppError } from './zod-i18n';
import { AppError } from '@/lib/errors/app-error';

describe('translateZodIssues', () => {
  it('maps too_small with min param to localized message', async () => {
    const schema = z.object({ name: z.string().min(3) });
    const result = schema.safeParse({ name: 'ab' });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('unreachable');

    const issues = await translateZodIssues(result.error);
    expect(issues).toHaveLength(1);
    expect(issues[0].path).toBe('name');
    expect(issues[0].catalogKey).toBe('validation.tooSmall');
    expect(issues[0].message).toBe('Must be 3 or greater');
  });

  it('maps invalid_type with expected param', async () => {
    const schema = z.object({ count: z.number() });
    const result = schema.safeParse({ count: 'oops' });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('unreachable');

    const issues = await translateZodIssues(result.error);
    expect(issues[0].catalogKey).toBe('validation.invalidType');
    expect(issues[0].message).toContain('expected number');
  });

  it('top-level path renders as empty string', async () => {
    const schema = z.string();
    const result = schema.safeParse(123);
    expect(result.success).toBe(false);
    if (result.success) throw new Error('unreachable');

    const issues = await translateZodIssues(result.error);
    expect(issues[0].path).toBe('');
  });
});

describe('parseOrThrowAppError', () => {
  it('returns parsed data on success', async () => {
    const schema = z.object({ name: z.string() });
    const data = await parseOrThrowAppError(schema, { name: 'tasukiba' });
    expect(data).toEqual({ name: 'tasukiba' });
  });

  it('throws AppError(VALIDATION_ERROR) on failure with issuesJson', async () => {
    const schema = z.object({ name: z.string().min(3) });
    await expect(parseOrThrowAppError(schema, { name: 'a' })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      httpStatus: 400,
    });
  });

  it('thrown AppError preserves localized issues in params.issuesJson', async () => {
    const schema = z.object({ age: z.number().min(18) });
    try {
      await parseOrThrowAppError(schema, { age: 5 });
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      const err = e as AppError;
      const issues = JSON.parse(String(err.params.issuesJson));
      expect(issues).toHaveLength(1);
      expect(issues[0].path).toBe('age');
      expect(issues[0].message).toBe('Must be 18 or greater');
    }
  });
});
