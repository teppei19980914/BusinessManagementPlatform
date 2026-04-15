import { describe, it, expect } from 'vitest';
import { checkPermission } from './check-permission';
import type { PermissionContext, Action } from './check-permission';

function ctx(overrides: Partial<PermissionContext> = {}): PermissionContext {
  return {
    userId: 'user-1',
    systemRole: 'general',
    projectRole: 'member',
    ...overrides,
  };
}

describe('checkPermission', () => {
  describe('admin ロール', () => {
    it('admin は全操作が許可される', () => {
      const actions: Action[] = [
        'project:create', 'project:read', 'project:update', 'project:delete',
        'task:create', 'task:read', 'task:update', 'task:delete',
        'knowledge:create', 'knowledge:read', 'knowledge:publish',
        'risk:create', 'risk:read', 'risk:update',
        'member:read', 'member:manage',
        'admin:users', 'admin:audit_logs',
      ];
      for (const action of actions) {
        const result = checkPermission(action, ctx({ systemRole: 'admin' }));
        expect(result.allowed, `admin should be allowed: ${action}`).toBe(true);
      }
    });

    it('admin でもクローズ状態では更新操作が拒否される', () => {
      const result = checkPermission('project:update', ctx({
        systemRole: 'admin',
        projectStatus: 'closed',
      }));
      expect(result.allowed).toBe(false);
    });
  });

  describe('pm_tl ロール', () => {
    it('プロジェクトの作成・編集・状態変更が許可される', () => {
      const c = ctx({ projectRole: 'pm_tl' });
      expect(checkPermission('project:create', c).allowed).toBe(true);
      expect(checkPermission('project:update', c).allowed).toBe(true);
      expect(checkPermission('project:change_status', c).allowed).toBe(true);
    });

    it('タスクの全操作が許可される', () => {
      const c = ctx({ projectRole: 'pm_tl' });
      expect(checkPermission('task:create', c).allowed).toBe(true);
      expect(checkPermission('task:update', c).allowed).toBe(true);
      expect(checkPermission('task:delete', c).allowed).toBe(true);
      expect(checkPermission('task:update_progress', c).allowed).toBe(true);
    });

    it('プロジェクト削除は拒否される', () => {
      const result = checkPermission('project:delete', ctx({ projectRole: 'pm_tl' }));
      expect(result.allowed).toBe(false);
    });

    it('システム管理機能は拒否される', () => {
      const c = ctx({ projectRole: 'pm_tl' });
      expect(checkPermission('admin:users', c).allowed).toBe(false);
      expect(checkPermission('admin:audit_logs', c).allowed).toBe(false);
    });

    it('メンバー管理は拒否される（admin のみ）', () => {
      expect(checkPermission('member:manage', ctx({ projectRole: 'pm_tl' })).allowed).toBe(false);
    });
  });

  describe('member ロール', () => {
    it('プロジェクトの閲覧は許可される', () => {
      expect(checkPermission('project:read', ctx({ projectRole: 'member' })).allowed).toBe(true);
    });

    it('プロジェクトの作成・編集は拒否される', () => {
      const c = ctx({ projectRole: 'member' });
      expect(checkPermission('project:create', c).allowed).toBe(false);
      expect(checkPermission('project:update', c).allowed).toBe(false);
    });

    it('タスクの閲覧は許可される', () => {
      expect(checkPermission('task:read', ctx({ projectRole: 'member' })).allowed).toBe(true);
    });

    it('タスクの作成・編集は拒否される', () => {
      const c = ctx({ projectRole: 'member' });
      expect(checkPermission('task:create', c).allowed).toBe(false);
      expect(checkPermission('task:update', c).allowed).toBe(false);
    });

    it('自分の担当タスクの進捗更新は許可される', () => {
      const result = checkPermission('task:update_progress', ctx({
        projectRole: 'member',
        resourceOwnerId: 'user-1',
      }));
      expect(result.allowed).toBe(true);
    });

    it('他人の担当タスクの進捗更新は拒否される', () => {
      const result = checkPermission('task:update_progress', ctx({
        projectRole: 'member',
        resourceOwnerId: 'user-2',
      }));
      expect(result.allowed).toBe(false);
    });

    it('ナレッジの作成は許可される', () => {
      expect(checkPermission('knowledge:create', ctx({ projectRole: 'member' })).allowed).toBe(true);
    });

    it('自分のナレッジの編集は許可される', () => {
      const result = checkPermission('knowledge:update', ctx({
        projectRole: 'member',
        resourceOwnerId: 'user-1',
      }));
      expect(result.allowed).toBe(true);
    });

    it('他人のナレッジの編集は拒否される', () => {
      const result = checkPermission('knowledge:update', ctx({
        projectRole: 'member',
        resourceOwnerId: 'user-2',
      }));
      expect(result.allowed).toBe(false);
    });

    it('ナレッジの公開は拒否される', () => {
      expect(checkPermission('knowledge:publish', ctx({ projectRole: 'member' })).allowed).toBe(false);
    });

    it('リスクの起票は許可される', () => {
      expect(checkPermission('risk:create', ctx({ projectRole: 'member' })).allowed).toBe(true);
    });

    it('自分のリスクの編集は許可される', () => {
      const result = checkPermission('risk:update', ctx({
        projectRole: 'member',
        resourceOwnerId: 'user-1',
      }));
      expect(result.allowed).toBe(true);
    });

    it('他人のリスクの編集は拒否される', () => {
      const result = checkPermission('risk:update', ctx({
        projectRole: 'member',
        resourceOwnerId: 'user-2',
      }));
      expect(result.allowed).toBe(false);
    });
  });

  describe('viewer ロール', () => {
    it('閲覧操作のみ許可される', () => {
      const c = ctx({ projectRole: 'viewer' });
      expect(checkPermission('project:read', c).allowed).toBe(true);
      expect(checkPermission('task:read', c).allowed).toBe(true);
      expect(checkPermission('knowledge:read', c).allowed).toBe(true);
      expect(checkPermission('risk:read', c).allowed).toBe(true);
    });

    it('作成・編集操作は全て拒否される', () => {
      const c = ctx({ projectRole: 'viewer' });
      expect(checkPermission('project:create', c).allowed).toBe(false);
      expect(checkPermission('task:create', c).allowed).toBe(false);
      expect(checkPermission('task:update_progress', c).allowed).toBe(false);
      expect(checkPermission('knowledge:create', c).allowed).toBe(false);
      expect(checkPermission('risk:create', c).allowed).toBe(false);
    });
  });

  describe('ロールなし（未所属）', () => {
    it('全操作が拒否される', () => {
      const c = ctx({ projectRole: null });
      expect(checkPermission('project:read', c).allowed).toBe(false);
      expect(checkPermission('task:read', c).allowed).toBe(false);
    });
  });

  describe('プロジェクト状態による制限', () => {
    it('closed 状態では閲覧のみ許可', () => {
      const c = ctx({ projectRole: 'pm_tl', projectStatus: 'closed' });
      expect(checkPermission('project:read', c).allowed).toBe(true);
      expect(checkPermission('task:read', c).allowed).toBe(true);
      expect(checkPermission('project:update', c).allowed).toBe(false);
      expect(checkPermission('task:create', c).allowed).toBe(false);
    });

    it('retrospected 状態ではナレッジ更新と状態変更が許可', () => {
      const c = ctx({ projectRole: 'pm_tl', projectStatus: 'retrospected' });
      expect(checkPermission('project:read', c).allowed).toBe(true);
      expect(checkPermission('project:change_status', c).allowed).toBe(true);
      expect(checkPermission('knowledge:update', c).allowed).toBe(true);
      expect(checkPermission('task:create', c).allowed).toBe(false);
    });
  });
});
