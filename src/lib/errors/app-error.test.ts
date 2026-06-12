import { describe, it, expect } from 'vitest';
import { AppError, isAppError, errorCatalogKey } from './app-error';

describe('AppError', () => {
  it('stores code, params, and computes default httpStatus', () => {
    const err = new AppError('TENANT_NOT_FOUND', { tenantId: 'abc' });
    expect(err.code).toBe('TENANT_NOT_FOUND');
    expect(err.params).toEqual({ tenantId: 'abc' });
    expect(err.httpStatus).toBe(404);
    expect(err.name).toBe('AppError');
  });

  it('default params is empty object', () => {
    const err = new AppError('INTERNAL_ERROR');
    expect(err.params).toEqual({});
    expect(err.httpStatus).toBe(500);
  });

  it('allows httpStatus override', () => {
    const err = new AppError('VALIDATION_ERROR', {}, 422);
    expect(err.httpStatus).toBe(422);
  });

  it('toJSON exposes only code + params (no stack / message)', () => {
    const err = new AppError('FORBIDDEN', { reason: 'tenant_boundary' });
    const json = err.toJSON();
    expect(json).toEqual({ code: 'FORBIDDEN', params: { reason: 'tenant_boundary' } });
    // Round-trip safety: JSON.stringify works.
    expect(JSON.parse(JSON.stringify(err))).toEqual(json);
  });

  it('is instanceof Error (so generic catchers still see it)', () => {
    const err = new AppError('NOT_FOUND');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AppError);
  });

  it('isAppError type guard', () => {
    expect(isAppError(new AppError('INTERNAL_ERROR'))).toBe(true);
    expect(isAppError(new Error('plain'))).toBe(false);
    expect(isAppError(null)).toBe(false);
    expect(isAppError({ code: 'INTERNAL_ERROR' })).toBe(false);
  });

  it('errorCatalogKey returns prefixed key', () => {
    expect(errorCatalogKey('TENANT_NOT_FOUND')).toBe('error.TENANT_NOT_FOUND');
    expect(errorCatalogKey('FORBIDDEN')).toBe('error.FORBIDDEN');
  });
});
