/**
 * プロジェクト状態遷移（設計書: DESIGN.md セクション 6）
 *
 * 状態遷移図 (2026-06-03: 完了/振り返り完了を廃止し 5 ステータスに簡素化):
 * planning → estimating → scheduling → executing → closed
 *
 * 注: 2026-06-03 以降、ステータスは新規作成/編集フォームから任意に選択する方式に移行したため、
 *     本 state-machine (一方向遷移) は dormant (新 UI からは未使用)。正準的な順序の記録として残置。
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
  { from: 'executing', to: 'closed' },
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
