import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { opLog, __setTestSinks } from './logger';

describe('opLog (operator structured logger)', () => {
  let stdoutLines: string[] = [];
  let stderrLines: string[] = [];

  beforeEach(() => {
    stdoutLines = [];
    stderrLines = [];
    __setTestSinks({
      stdout: (line) => stdoutLines.push(line),
      stderr: (line) => stderrLines.push(line),
    });
  });

  afterEach(() => {
    __setTestSinks({}); // reset
  });

  it('emits a JSON line per call with ts/level/event', () => {
    opLog.info('tenant.suspend.completed', { tenantId: 'abc' });
    expect(stdoutLines).toHaveLength(1);
    expect(stderrLines).toHaveLength(0);
    const obj = JSON.parse(stdoutLines[0]);
    expect(obj.level).toBe('info');
    expect(obj.event).toBe('tenant.suspend.completed');
    expect(obj.tenantId).toBe('abc');
    expect(typeof obj.ts).toBe('string');
    // ISO 8601 format
    expect(obj.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('routes info to stdout and warn/error to stderr', () => {
    opLog.info('a.b', {});
    opLog.warn('c.d', {});
    opLog.error('e.f', {});
    expect(stdoutLines).toHaveLength(1);
    expect(stderrLines).toHaveLength(2);
    expect(JSON.parse(stderrLines[0]).level).toBe('warn');
    expect(JSON.parse(stderrLines[1]).level).toBe('error');
  });

  it('handles missing fields argument', () => {
    opLog.info('plain.event');
    const obj = JSON.parse(stdoutLines[0]);
    expect(obj.event).toBe('plain.event');
    expect(obj.level).toBe('info');
  });

  it('appends a newline so output is line-delimited JSON', () => {
    opLog.info('e', { x: 1 });
    expect(stdoutLines[0].endsWith('\n')).toBe(true);
  });

  it('preserves nested object fields', () => {
    opLog.warn('mail.fail', { provider: 'brevo', context: { status: 502, attempt: 3 } });
    const obj = JSON.parse(stderrLines[0]);
    expect(obj.context).toEqual({ status: 502, attempt: 3 });
  });
});
