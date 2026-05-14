/**
 * classifyWorkloadLevel の境界条件テスト (PR #361)
 */

import { describe, it, expect } from 'vitest';
import {
  classifyWorkloadLevel,
  WORKLOAD_WARN_HOURS,
  WORKLOAD_ALERT_HOURS,
} from './workload';

describe('classifyWorkloadLevel', () => {
  it('0h → ok', () => {
    expect(classifyWorkloadLevel(0)).toBe('ok');
  });

  it('6.9h → ok (warn 閾値未満)', () => {
    expect(classifyWorkloadLevel(6.9)).toBe('ok');
  });

  it('7.0h ちょうど → ok (境界、「超える」ではないため)', () => {
    expect(classifyWorkloadLevel(WORKLOAD_WARN_HOURS)).toBe('ok');
  });

  it('7.01h → warning (warn 閾値超え)', () => {
    expect(classifyWorkloadLevel(7.01)).toBe('warning');
  });

  it('7.5h → warning', () => {
    expect(classifyWorkloadLevel(7.5)).toBe('warning');
  });

  it('8.0h ちょうど → warning (alert 閾値未満)', () => {
    expect(classifyWorkloadLevel(WORKLOAD_ALERT_HOURS)).toBe('warning');
  });

  it('8.01h → alert (alert 閾値超え)', () => {
    expect(classifyWorkloadLevel(8.01)).toBe('alert');
  });

  it('12h → alert', () => {
    expect(classifyWorkloadLevel(12)).toBe('alert');
  });

  it('閾値定数の値が要件と一致 (7h / 8h)', () => {
    expect(WORKLOAD_WARN_HOURS).toBe(7);
    expect(WORKLOAD_ALERT_HOURS).toBe(8);
  });
});
