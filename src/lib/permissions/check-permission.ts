/**
 * 権限チェック（設計書: DESIGN.md セクション 8.2, 9.5）
 *
 * 判定式: 操作可 = メンバーである AND ロール可 AND 状態可 AND 所有者条件可
 * Fail Secure: 判定に失敗した場合は拒否（デフォルト拒否）
 */

import type { ProjectRole, SystemRole, ProjectStatus } from '@/types';

export type PermissionContext = {
  userId: string;
  systemRole: SystemRole;
  projectId?: string;
  projectRole?: ProjectRole | null;
  projectStatus?: ProjectStatus;
  resourceOwnerId?: string;
};

export type PermissionResult = {
  allowed: boolean;
  reason?: string;
};

// アクション定義
export type Action =
  // プロジェクト
  | 'project:create'
  | 'project:read'
  | 'project:update'
  | 'project:delete'
  | 'project:change_status'
  // タスク
  | 'task:create'
  | 'task:read'
  | 'task:update'
  | 'task:update_progress'
  | 'task:delete'
  // ナレッジ
  | 'knowledge:create'
  | 'knowledge:read'
  | 'knowledge:update'
  | 'knowledge:delete'
  | 'knowledge:publish'
  // リスク/課題
  | 'risk:create'
  | 'risk:read'
  | 'risk:update'
  | 'risk:delete'
  // メンバー管理
  | 'member:read'
  | 'member:manage'
  // ユーザ管理
  | 'admin:users'
  | 'admin:audit_logs';

// ロール別の許可アクション
const ROLE_PERMISSIONS: Record<string, Set<Action>> = {
  admin: new Set([
    'project:create', 'project:read', 'project:update', 'project:delete', 'project:change_status',
    'task:create', 'task:read', 'task:update', 'task:update_progress', 'task:delete',
    'knowledge:create', 'knowledge:read', 'knowledge:update', 'knowledge:delete', 'knowledge:publish',
    'risk:create', 'risk:read', 'risk:update', 'risk:delete',
    'member:read', 'member:manage',
    'admin:users', 'admin:audit_logs',
  ]),
  pm_tl: new Set([
    'project:create', 'project:read', 'project:update', 'project:change_status',
    'task:create', 'task:read', 'task:update', 'task:update_progress', 'task:delete',
    'knowledge:create', 'knowledge:read', 'knowledge:update', 'knowledge:delete', 'knowledge:publish',
    'risk:create', 'risk:read', 'risk:update', 'risk:delete',
    'member:read',
  ]),
  member: new Set([
    'project:read',
    'task:read', 'task:update_progress',
    'knowledge:create', 'knowledge:read', 'knowledge:update',
    'risk:create', 'risk:read', 'risk:update',
  ]),
  viewer: new Set([
    'project:read',
    'task:read',
    'knowledge:read',
    'risk:read',
  ]),
};

// プロジェクト状態別の許可アクション
const STATE_RESTRICTIONS: Partial<Record<ProjectStatus, Set<Action>>> = {
  closed: new Set(['project:read', 'task:read', 'knowledge:read', 'risk:read']),
  retrospected: new Set([
    'project:read', 'project:change_status',
    'task:read',
    'knowledge:read', 'knowledge:update',
    'risk:read',
  ]),
};

export function checkPermission(
  action: Action,
  context: PermissionContext,
): PermissionResult {
  // 1. システム管理者は（ロールチェックで）全操作可
  if (context.systemRole === 'admin') {
    // ただし状態制約は適用
    if (context.projectStatus) {
      const stateRestriction = STATE_RESTRICTIONS[context.projectStatus];
      if (stateRestriction && !stateRestriction.has(action)) {
        return { allowed: false, reason: 'この状態では実行できません' };
      }
    }
    return { allowed: true };
  }

  // 2. プロジェクトロールによるチェック
  const effectiveRole = context.projectRole || 'none';
  const allowedActions = ROLE_PERMISSIONS[effectiveRole];

  if (!allowedActions || !allowedActions.has(action)) {
    return { allowed: false, reason: 'この操作を実行する権限がありません' };
  }

  // 3. プロジェクト状態によるチェック
  if (context.projectStatus) {
    const stateRestriction = STATE_RESTRICTIONS[context.projectStatus];
    if (stateRestriction && !stateRestriction.has(action)) {
      return { allowed: false, reason: 'この状態では実行できません' };
    }
  }

  // 4. メンバーの所有者条件チェック
  if (effectiveRole === 'member') {
    // メンバーのナレッジ更新は自分が作成したもののみ
    if (action === 'knowledge:update' && context.resourceOwnerId) {
      if (context.resourceOwnerId !== context.userId) {
        return { allowed: false, reason: '自分が作成したナレッジのみ編集できます' };
      }
    }
    // メンバーの進捗更新は自分が担当のタスクのみ
    if (action === 'task:update_progress' && context.resourceOwnerId) {
      if (context.resourceOwnerId !== context.userId) {
        return { allowed: false, reason: '自分が担当のタスクのみ進捗更新できます' };
      }
    }
    // メンバーのリスク更新は自分が起票/担当のもののみ
    if (action === 'risk:update' && context.resourceOwnerId) {
      if (context.resourceOwnerId !== context.userId) {
        return { allowed: false, reason: '自分が起票または担当のリスク/課題のみ編集できます' };
      }
    }
  }

  return { allowed: true };
}
