/**
 * プロジェクト状態遷移（設計書: DESIGN.md セクション 6）
 *
 * 状態遷移図:
 * planning → estimating → scheduling → executing → completed → retrospected → closed
 */

import type { ProjectStatus } from '@/types';

type TransitionRule = {
  from: ProjectStatus;
  to: ProjectStatus;
};

const ALLOWED_TRANSITIONS: TransitionRule[] = [
  { from: 'planning', to: 'estimating' },
  { from: 'estimating', to: 'scheduling' },
  { from: 'scheduling', to: 'executing' },
  { from: 'executing', to: 'completed' },
  { from: 'completed', to: 'retrospected' },
  { from: 'retrospected', to: 'closed' },
];

export function canTransition(
  from: ProjectStatus,
  to: ProjectStatus,
): { allowed: boolean; reason?: string } {
  const rule = ALLOWED_TRANSITIONS.find((r) => r.from === from && r.to === to);

  if (!rule) {
    return {
      allowed: false,
      reason: `${from} から ${to} への遷移はできません`,
    };
  }

  return { allowed: true };
}

export function getNextStatuses(current: ProjectStatus): ProjectStatus[] {
  return ALLOWED_TRANSITIONS.filter((r) => r.from === current).map((r) => r.to);
}
