/**
 * faq-content.ts の権限フィルタ invariant テスト (PR5)。
 *
 * **★severity-1★ 対応**: フクロウの「情報流出を防ぐ鍵」コンセプト ([[project_mascot_owl]]) を
 * 守るため、getFaqEntriesForRole が viewer の権限に応じて FAQ を厳密にフィルタすることを
 * 機械的に担保する。billing 系 FAQ が一般メンバーに漏洩しないこと、project_pm 系 FAQ が
 * 非 PM ユーザに漏洩しないことが本テストの核。
 */

import { describe, it, expect } from 'vitest';
import {
  FAQ_ENTRIES,
  getFaqEntriesForRole,
  getFaqEntryById,
  buildFaqPromptSection,
  buildRoleGuardancePromptSection,
  type ViewerRoles,
} from './faq-content';

const VIEWER_GENERAL: ViewerRoles = {
  isTenantAdmin: false,
  hasAnyProjectPmRole: false,
};
const VIEWER_PM: ViewerRoles = {
  isTenantAdmin: false,
  hasAnyProjectPmRole: true,
};
const VIEWER_ADMIN: ViewerRoles = {
  isTenantAdmin: true,
  hasAnyProjectPmRole: true,
};

describe('FAQ_ENTRIES 基本 invariant', () => {
  it('全 FAQ の id が一意である (sourceFaqIds 重複防止)', () => {
    const ids = FAQ_ENTRIES.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('全 FAQ が q と a を持つ (空文字禁止)', () => {
    for (const e of FAQ_ENTRIES) {
      expect(e.q.length).toBeGreaterThan(0);
      expect(e.a.length).toBeGreaterThan(0);
    }
  });
});

describe('getFaqEntriesForRole 権限フィルタ (★severity-1★)', () => {
  it('一般メンバーは visibleTo=all のみが見える (billing 系は除外される)', () => {
    const result = getFaqEntriesForRole(VIEWER_GENERAL);
    // billing カテゴリの FAQ が含まれていないこと (料金体系は tenant_admin 限定)
    const billingFaqs = result.filter((e) => e.category === 'billing');
    expect(billingFaqs.length).toBe(0);
    // admin カテゴリ (= ダウングレード不可) も含まれていない
    const adminFaqs = result.filter((e) => e.category === 'admin');
    expect(adminFaqs.length).toBe(0);
    // import (CSV 取込) も tenant_admin 限定
    const importFaqs = result.filter((e) => e.category === 'import');
    expect(importFaqs.length).toBe(0);
  });

  it('一般メンバーは visibleTo=all の FAQ のみを受け取る (個別 entry 検証)', () => {
    const result = getFaqEntriesForRole(VIEWER_GENERAL);
    for (const e of result) {
      expect(e.visibleTo).toBe('all');
    }
  });

  it('PM/PL ロール持ちは all + project_pm を受け取る (tenant_admin 限定は除外)', () => {
    const result = getFaqEntriesForRole(VIEWER_PM);
    for (const e of result) {
      expect(['all', 'project_pm']).toContain(e.visibleTo);
    }
    // billing / admin / import は依然として除外
    expect(result.filter((e) => e.category === 'billing').length).toBe(0);
  });

  it('テナント管理者 + PM は全 FAQ が見える', () => {
    const result = getFaqEntriesForRole(VIEWER_ADMIN);
    expect(result.length).toBe(FAQ_ENTRIES.length);
  });

  it('★severity-1★ 「いつ請求されますか?」(billing) は一般メンバーから絶対に見えない', () => {
    const general = getFaqEntriesForRole(VIEWER_GENERAL);
    const billingCycle = general.find((e) => e.id === 'billing-cycle');
    expect(billingCycle).toBeUndefined();

    const admin = getFaqEntriesForRole(VIEWER_ADMIN);
    const billingCycleAdmin = admin.find((e) => e.id === 'billing-cycle');
    expect(billingCycleAdmin).toBeDefined();
  });
});

describe('buildFaqPromptSection (AI prompt 同梱用)', () => {
  it('viewer のロールに応じてフィルタされた FAQ のみを含む', () => {
    const generalPrompt = buildFaqPromptSection(VIEWER_GENERAL);
    // 一般メンバーには料金 FAQ が含まれない
    expect(generalPrompt).not.toContain('billing-cycle');
    expect(generalPrompt).not.toContain('翌月 25 日');

    const adminPrompt = buildFaqPromptSection(VIEWER_ADMIN);
    // 管理者には含まれる
    expect(adminPrompt).toContain('billing-cycle');
    expect(adminPrompt).toContain('翌月 25 日');
  });

  it('各 FAQ が [id] (カテゴリ) Q: ... A: ... 形式で出力される', () => {
    const prompt = buildFaqPromptSection(VIEWER_ADMIN);
    expect(prompt).toMatch(/\[tenant-deletion\]/);
    expect(prompt).toMatch(/Q: 退会するとデータはどうなりますか？/);
    expect(prompt).toMatch(/A: プランによって異なります/);
  });
});

describe('buildRoleGuardancePromptSection (権限ガイダンス)', () => {
  it('一般メンバーには「料金は tenant_admin へ」と「PM 機能は PM/PL へ」の両方が含まれる', () => {
    const guidance = buildRoleGuardancePromptSection(VIEWER_GENERAL);
    expect(guidance).toContain('料金体系・課金詳細');
    expect(guidance).toContain('テナント管理者');
    expect(guidance).toContain('PM/PL ロール');
  });

  it('PM/PL ロールのみのユーザには「料金は tenant_admin へ」が含まれ「PM/PL」は含まれない', () => {
    const guidance = buildRoleGuardancePromptSection(VIEWER_PM);
    expect(guidance).toContain('料金体系・課金詳細');
    expect(guidance).not.toContain('PM/PL ロールの方にお尋ねください');
  });

  it('全権限ユーザには「開示制限なし」と返る', () => {
    const guidance = buildRoleGuardancePromptSection(VIEWER_ADMIN);
    expect(guidance).toContain('開示制限はありません');
  });
});

describe('getFaqEntryById (deep link 解決用)', () => {
  it('存在する id で entry を返す', () => {
    const entry = getFaqEntryById('billing-cycle');
    expect(entry).toBeDefined();
    expect(entry?.id).toBe('billing-cycle');
  });

  it('存在しない id で undefined を返す', () => {
    const entry = getFaqEntryById('non-existent-id');
    expect(entry).toBeUndefined();
  });
});
