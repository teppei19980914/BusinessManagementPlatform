import { describe, it, expect } from 'vitest';
import { canTransition, getNextStatuses } from './state-machine';
import type { ProjectStatus } from '@/types';

describe('canTransition', () => {
  const validTransitions: [ProjectStatus, ProjectStatus][] = [
    ['planning', 'estimating'],
    ['estimating', 'scheduling'],
    ['scheduling', 'executing'],
    ['executing', 'completed'],
    ['completed', 'retrospected'],
    ['retrospected', 'closed'],
  ];

  for (const [from, to] of validTransitions) {
    it(`${from} → ${to} は許可される`, () => {
      const result = canTransition(from, to);
      expect(result.allowed).toBe(true);
    });
  }

  it('逆方向の遷移は拒否される（estimating → planning）', () => {
    const result = canTransition('estimating', 'planning');
    expect(result.allowed).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it('スキップ遷移は拒否される（planning → scheduling）', () => {
    const result = canTransition('planning', 'scheduling');
    expect(result.allowed).toBe(false);
  });

  it('同一状態への遷移は拒否される', () => {
    const result = canTransition('executing', 'executing');
    expect(result.allowed).toBe(false);
  });

  it('closed からの遷移は全て拒否される', () => {
    const statuses: ProjectStatus[] = [
      'planning', 'estimating', 'scheduling', 'executing', 'completed', 'retrospected',
    ];
    for (const to of statuses) {
      const result = canTransition('closed', to);
      expect(result.allowed, `closed → ${to} should be rejected`).toBe(false);
    }
  });

  it('planning → closed は拒否される（途中スキップ不可）', () => {
    const result = canTransition('planning', 'closed');
    expect(result.allowed).toBe(false);
  });
});

describe('getNextStatuses', () => {
  it('planning の次は estimating のみ', () => {
    expect(getNextStatuses('planning')).toEqual(['estimating']);
  });

  it('executing の次は completed のみ', () => {
    expect(getNextStatuses('executing')).toEqual(['completed']);
  });

  it('closed の次はなし', () => {
    expect(getNextStatuses('closed')).toEqual([]);
  });

  it('各状態に正しい遷移先が設定されている', () => {
    expect(getNextStatuses('estimating')).toEqual(['scheduling']);
    expect(getNextStatuses('scheduling')).toEqual(['executing']);
    expect(getNextStatuses('completed')).toEqual(['retrospected']);
    expect(getNextStatuses('retrospected')).toEqual(['closed']);
  });
});
