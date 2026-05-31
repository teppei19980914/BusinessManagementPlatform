/**
 * guide-content.ts の権限フィルタ invariant テスト (PR5)。
 * faq-content と同じ「情報流出を防ぐ鍵」コンセプトを使い方ガイドにも横展開していることを担保。
 */

import { describe, it, expect } from 'vitest';
import {
  GUIDE_STEPS,
  getGuideStepsForRole,
  buildGuidePromptSection,
  type GuideStep,
} from './guide-content';
import type { ViewerRoles } from './faq-content';

// VIEWER_GENERAL = 未所属 / viewer のみ (project_member も project_pm も見られない)
const VIEWER_GENERAL: ViewerRoles = { isTenantAdmin: false, hasAnyProjectPmRole: false, hasAnyProjectMembership: false };
const VIEWER_PM: ViewerRoles = { isTenantAdmin: false, hasAnyProjectPmRole: true, hasAnyProjectMembership: true };
const VIEWER_ADMIN: ViewerRoles = { isTenantAdmin: true, hasAnyProjectPmRole: true, hasAnyProjectMembership: true };

describe('GUIDE_STEPS 基本 invariant', () => {
  it('全 step の id が一意である', () => {
    const ids = GUIDE_STEPS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('全 step が title と body を持つ', () => {
    for (const s of GUIDE_STEPS) {
      expect(s.title.length).toBeGreaterThan(0);
      expect(s.body.length).toBeGreaterThan(0);
    }
  });
});

describe('getGuideStepsForRole 権限フィルタ (★severity-1★)', () => {
  it('★severity-1★ ユーザ指示通り: 一般メンバーは「提案エンジン (参考タブ)」を見られない (project_pm)', () => {
    const general = getGuideStepsForRole(VIEWER_GENERAL);
    const suggestionEngine = general.find((s) => s.id === 'suggestion-engine');
    expect(suggestionEngine).toBeUndefined();

    const pm = getGuideStepsForRole(VIEWER_PM);
    expect(pm.find((s) => s.id === 'suggestion-engine')).toBeDefined();
  });

  it('一般メンバーは「メンバー招待」(tenant_admin) を見られない', () => {
    const general = getGuideStepsForRole(VIEWER_GENERAL);
    const inviteMembers = general.find((s) => s.id === 'invite-members');
    expect(inviteMembers).toBeUndefined();

    const admin = getGuideStepsForRole(VIEWER_ADMIN);
    expect(admin.find((s) => s.id === 'invite-members')).toBeDefined();
  });

  it('全 step を見られるのは isTenantAdmin かつ hasAnyProjectPmRole の場合のみ', () => {
    const admin = getGuideStepsForRole(VIEWER_ADMIN);
    expect(admin.length).toBe(GUIDE_STEPS.length);

    const general = getGuideStepsForRole(VIEWER_GENERAL);
    expect(general.length).toBeLessThan(GUIDE_STEPS.length);
  });
});

describe('buildGuidePromptSection', () => {
  it('一般メンバー向けプロンプトには「提案エンジン」step が含まれない', () => {
    const prompt = buildGuidePromptSection(VIEWER_GENERAL);
    expect(prompt).not.toContain('suggestion-engine');
    expect(prompt).not.toContain('参考タブ');
  });

  it('PM 向けプロンプトには「提案エンジン」step が含まれる', () => {
    const prompt = buildGuidePromptSection(VIEWER_PM);
    expect(prompt).toContain('suggestion-engine');
    expect(prompt).toContain('参考タブ');
  });
});

/**
 * PR9 (2026-05-29): 業務手順ガイドを 9 件追加した invariant 検証。
 *   ユーザ指示: 「特にシステム管理者が初回ログインしたとき、データインポート手順を
 *   具体的にフクロウが返答 = 離脱防止」
 */
describe('PR9 業務手順ガイド invariant', () => {
  it('GUIDE_STEPS は 17 件以上 (PR9 で 8 → 17+)', () => {
    expect(GUIDE_STEPS.length).toBeGreaterThanOrEqual(17);
  });

  it('テナント管理者の初日 + 外部データ移行ウィザード + ZIP 取込 が tenant_admin 限定で含まれる', () => {
    const expectedAdminSteps = [
      'tenant-admin-first-day', // 初日 4 ステップ
      'external-import-wizard-full-walkthrough', // 6 ステップ詳細
      'zip-tenant-import-walkthrough', // ZIP 一括取込
      'invite-member-walkthrough',
      'plan-upgrade-walkthrough',
      'budget-cap-walkthrough',
      'self-cancellation-walkthrough',
      'csv-edit-cheatsheet',
    ];
    for (const id of expectedAdminSteps) {
      const step = GUIDE_STEPS.find((s) => s.id === id);
      expect(step, `step '${id}' should exist`).toBeDefined();
      expect(step?.visibleTo, `step '${id}' should be tenant_admin`).toBe('tenant_admin');
    }
  });

  it('MFA セットアップガイドは all (一般メンバーも有効化可能)', () => {
    const mfa = GUIDE_STEPS.find((s) => s.id === 'mfa-setup-walkthrough');
    expect(mfa).toBeDefined();
    expect(mfa?.visibleTo).toBe('all');
  });

  it('一般メンバーには CSV / インポート / 課金関連ガイドが漏れない (severity-1)', () => {
    const general = getGuideStepsForRole(VIEWER_GENERAL);
    const leakedAdminSteps = general.filter((s) =>
      s.id.includes('import') ||
      s.id.includes('plan') ||
      s.id.includes('budget') ||
      s.id.includes('self-cancellation') ||
      s.id.includes('csv-edit'),
    );
    expect(leakedAdminSteps).toEqual([]);
  });

  it('テナント管理者には主要 17 step がすべて開示', () => {
    const admin = getGuideStepsForRole(VIEWER_ADMIN);
    expect(admin.length).toBe(GUIDE_STEPS.length);
  });
});
