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
  // ステークホルダー管理 (PMBOK 13)
  // 可視性: PM/TL + admin のみ。個人情報・人物評を含むため member 以下には公開しない。
  | 'stakeholder:read'
  | 'stakeholder:create'
  | 'stakeholder:update'
  | 'stakeholder:delete'
  // 分析タブ (PM/PL + admin のみ。WBS 予実カーブ等の進捗分析を閲覧)
  | 'analytics:read'
  // ユーザ管理
  | 'admin:users'
  | 'admin:audit_logs'
  // アイデア出し機能 (v1.5.0)
  // idea:read    = セッション一覧・結果の閲覧 (viewer 以上)
  // idea:submit  = 投票・付箋・Q&A 投稿 (member 以上)
  // idea:manage  = セッション作成・クローズ・削除 (member 以上; creator-only チェックはサービス層)
  | 'idea:read'
  | 'idea:submit'
  | 'idea:manage';

// ロール別の許可アクション
const ROLE_PERMISSIONS: Record<string, Set<Action>> = {
  admin: new Set([
    'project:create', 'project:read', 'project:update', 'project:delete', 'project:change_status',
    'task:create', 'task:read', 'task:update', 'task:update_progress', 'task:delete',
    'knowledge:create', 'knowledge:read', 'knowledge:update', 'knowledge:delete', 'knowledge:publish',
    'risk:create', 'risk:read', 'risk:update', 'risk:delete',
    'member:read', 'member:manage',
    // ステークホルダー: admin は全プロジェクト全 CRUD 可
    'stakeholder:read', 'stakeholder:create', 'stakeholder:update', 'stakeholder:delete',
    // 分析タブ: admin は閲覧可
    'analytics:read',
    'admin:users', 'admin:audit_logs',
    // アイデア出し機能: admin は全操作可
    'idea:read', 'idea:submit', 'idea:manage',
  ]),
  pm_tl: new Set([
    'project:create', 'project:read', 'project:update', 'project:change_status',
    'task:create', 'task:read', 'task:update', 'task:update_progress', 'task:delete',
    'knowledge:create', 'knowledge:read', 'knowledge:update', 'knowledge:delete', 'knowledge:publish',
    'risk:create', 'risk:read', 'risk:update', 'risk:delete',
    // feat/crud-permission-redesign (2026-05-20): PM/TL にメンバー管理を開放。
    //   member/viewer の追加・削除・ロール変更は PM/TL 実行可、ただし「PM/TL ロール」を
    //   扱う操作 (PM/TL 追加・削除、PM/TL↔それ以外のロール変更) は admin only とする。
    //   後者の細粒度判定は check-permission.ts では表現できないため member.service.ts で実施。
    'member:read', 'member:manage',
    // ステークホルダー: PM/TL のみ全 CRUD 可 (人物評を含むため member 以下は閲覧不可)
    'stakeholder:read', 'stakeholder:create', 'stakeholder:update', 'stakeholder:delete',
    // 分析タブ: PM/TL は閲覧可 (現在地・生産性の把握)
    'analytics:read',
    // アイデア出し機能: PM/TL は全操作可
    'idea:read', 'idea:submit', 'idea:manage',
  ]),
  member: new Set([
    'project:read',
    // 2026-05-09 (#6): メンバーにも WBS タスクの新規作成を許可。
    //   現場の作業項目は実作業者である member 自身が定義することが多く、
    //   PM/TL に作成依頼してから着手するのは運用上のボトルネックになっていた。
    //   `task:update` (= 他人が作ったタスクの編集) は引き続き禁止。member の編集系は
    //   `task:update_progress` (自分担当のタスクの進捗更新) のみ。
    'task:create', 'task:read', 'task:update_progress',
    'knowledge:create', 'knowledge:read', 'knowledge:update',
    'risk:create', 'risk:read', 'risk:update',
    // ステークホルダー: member は閲覧不可 (個人情報保護)
    // アイデア出し機能: member は投票・付箋・Q&A 投稿 + セッション作成可
    'idea:read', 'idea:submit', 'idea:manage',
  ]),
  viewer: new Set([
    'project:read',
    'task:read',
    'knowledge:read',
    'risk:read',
    // ステークホルダー: viewer も閲覧不可
    // アイデア出し機能: viewer は閲覧のみ (投票・付箋・Q&A 投稿は不可)
    'idea:read',
  ]),
};

// プロジェクト状態別の許可アクション
// 2026-06-03: 完了/振り返り完了を廃止。クローズのみ制限対象。
//   クローズ = 完全な読み取り専用。ただし **削除 (project:delete) は許可** (ユーザ要望)。
const STATE_RESTRICTIONS: Partial<Record<ProjectStatus, Set<Action>>> = {
  closed: new Set([
    'project:read', 'project:delete',
    'task:read', 'knowledge:read', 'risk:read', 'stakeholder:read',
    // 分析は読み取り専用。完了案件こそ振り返り分析の価値が高いため closed でも許可。
    'analytics:read',
    // アイデア機能: closed プロジェクトでも過去記録を閲覧可能。投票・投稿は不可。
    'idea:read',
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
