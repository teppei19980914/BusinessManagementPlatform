/**
 * feat/collapsed-nav-screen-title (2026-06-05): getScreenTitleNavKey の単体テスト。
 *
 * 観点:
 *   - 代表的な画面パスが正しい nav キーに解決される
 *   - プロジェクト一覧 (/projects) と 詳細・タブ (/projects/[id]...) を区別する
 *   - longest-prefix: /settings/tenant が /settings より優先される
 *   - 該当なし (例: 認証画面) は null
 *   - ★ 返す nav キーが ja / en の nav namespace に必ず存在する (drift guard)
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { getScreenTitleNavKey } from './screen-title';

describe('getScreenTitleNavKey', () => {
  it('全○○ / 個人 / 管理 画面が正しい nav キーに解決される', () => {
    expect(getScreenTitleNavKey('/projects')).toBe('allProjects');
    expect(getScreenTitleNavKey('/knowledge')).toBe('allKnowledge');
    expect(getScreenTitleNavKey('/all-memos')).toBe('allMemos');
    expect(getScreenTitleNavKey('/risks')).toBe('allRisks');
    expect(getScreenTitleNavKey('/issues')).toBe('allIssues');
    expect(getScreenTitleNavKey('/retrospectives')).toBe('allRetrospectives');
    expect(getScreenTitleNavKey('/my-tasks')).toBe('myTasks');
    expect(getScreenTitleNavKey('/memos')).toBe('memos');
    expect(getScreenTitleNavKey('/customers')).toBe('allCustomers');
    expect(getScreenTitleNavKey('/customers/abc-123')).toBe('allCustomers');
    expect(getScreenTitleNavKey('/settings')).toBe('settings');
    expect(getScreenTitleNavKey('/guide')).toBe('guide');
    expect(getScreenTitleNavKey('/help')).toBe('help');
    expect(getScreenTitleNavKey('/changelog')).toBe('versionInfo');
    expect(getScreenTitleNavKey('/admin/users')).toBe('adminUsers');
    expect(getScreenTitleNavKey('/admin/audit-logs')).toBe('adminAuditLogs');
    expect(getScreenTitleNavKey('/admin/role-changes')).toBe('adminRoleChanges');
  });

  it('プロジェクト: 一覧と詳細・タブを区別する', () => {
    expect(getScreenTitleNavKey('/projects')).toBe('allProjects');
    expect(getScreenTitleNavKey('/projects/abc-123')).toBe('groupProjects');
    expect(getScreenTitleNavKey('/projects/abc-123/tasks')).toBe('groupProjects');
    expect(getScreenTitleNavKey('/projects/abc-123/gantt')).toBe('groupProjects');
  });

  it('longest-prefix: /settings/tenant 系は tenantSettings (settings より優先)', () => {
    expect(getScreenTitleNavKey('/settings/tenant')).toBe('tenantSettings');
    expect(getScreenTitleNavKey('/settings/tenant/billing')).toBe('tenantSettings');
    expect(getScreenTitleNavKey('/settings/tenant/migration-import')).toBe('tenantSettings');
  });

  it('運営者画面 (/admin/super 系) を区別する', () => {
    expect(getScreenTitleNavKey('/admin/super')).toBe('superAdminDashboard');
    expect(getScreenTitleNavKey('/admin/super/tenants')).toBe('superAdminTenants');
    expect(getScreenTitleNavKey('/admin/super/usage')).toBe('superAdminUsage');
  });

  it('該当しないパスは null (画面名を表示しない)', () => {
    expect(getScreenTitleNavKey('/login')).toBeNull();
    expect(getScreenTitleNavKey('/setup-password')).toBeNull();
    expect(getScreenTitleNavKey('/')).toBeNull();
  });

  it('★drift guard: 返しうる nav キーがすべて ja / en の nav namespace に存在する', () => {
    const root = process.cwd();
    const ja = JSON.parse(readFileSync(join(root, 'src/i18n/messages/ja.json'), 'utf-8')).nav;
    const en = JSON.parse(readFileSync(join(root, 'src/i18n/messages/en-US.json'), 'utf-8')).nav;

    const paths = [
      '/projects', '/projects/x', '/my-tasks', '/risks', '/issues',
      '/retrospectives', '/knowledge', '/all-memos', '/memos', '/customers',
      '/settings', '/settings/tenant', '/guide', '/help', '/changelog',
      '/admin/users', '/admin/audit-logs', '/admin/role-changes',
      '/admin/super', '/admin/super/tenants', '/admin/super/usage',
    ];
    const keys = [...new Set(paths.map((p) => getScreenTitleNavKey(p)).filter((k): k is string => k !== null))];
    for (const key of keys) {
      expect(ja[key], `ja.nav.${key} が存在しない`).toBeTruthy();
      expect(en[key], `en.nav.${key} が存在しない`).toBeTruthy();
    }
  });
});
