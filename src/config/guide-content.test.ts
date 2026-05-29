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

const VIEWER_GENERAL: ViewerRoles = { isTenantAdmin: false, hasAnyProjectPmRole: false };
const VIEWER_PM: ViewerRoles = { isTenantAdmin: false, hasAnyProjectPmRole: true };
const VIEWER_ADMIN: ViewerRoles = { isTenantAdmin: true, hasAnyProjectPmRole: true };

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
