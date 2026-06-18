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
  canViewerSee,
  type ViewerRoles,
} from './faq-content';

// VIEWER_GENERAL = 未所属 / viewer のみの一般ユーザ (project_member も見られない)
const VIEWER_GENERAL: ViewerRoles = {
  isTenantAdmin: false,
  hasAnyProjectPmRole: false,
  hasAnyProjectMembership: false,
};
// VIEWER_MEMBER = どこかのプロジェクトで member 以上 (project_member は見られるが PM 限定は不可)
const VIEWER_MEMBER: ViewerRoles = {
  isTenantAdmin: false,
  hasAnyProjectPmRole: false,
  hasAnyProjectMembership: true,
};
const VIEWER_PM: ViewerRoles = {
  isTenantAdmin: false,
  hasAnyProjectPmRole: true,
  hasAnyProjectMembership: true,
};
const VIEWER_ADMIN: ViewerRoles = {
  isTenantAdmin: true,
  hasAnyProjectPmRole: true,
  hasAnyProjectMembership: true,
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

describe('canViewerSee 開示4段の階層内包 (★severity-1★ 最小権限)', () => {
  it('all は全員に開示', () => {
    expect(canViewerSee('all', VIEWER_GENERAL)).toBe(true);
    expect(canViewerSee('all', VIEWER_MEMBER)).toBe(true);
    expect(canViewerSee('all', VIEWER_PM)).toBe(true);
    expect(canViewerSee('all', VIEWER_ADMIN)).toBe(true);
  });

  it('project_member は member 以上 / PM / admin のみ (viewer・未所属は不可)', () => {
    expect(canViewerSee('project_member', VIEWER_GENERAL)).toBe(false);
    expect(canViewerSee('project_member', VIEWER_MEMBER)).toBe(true);
    expect(canViewerSee('project_member', VIEWER_PM)).toBe(true);
    expect(canViewerSee('project_member', VIEWER_ADMIN)).toBe(true);
  });

  it('project_pm は PM / admin のみ (member は不可 = 内包の上限)', () => {
    expect(canViewerSee('project_pm', VIEWER_GENERAL)).toBe(false);
    expect(canViewerSee('project_pm', VIEWER_MEMBER)).toBe(false);
    expect(canViewerSee('project_pm', VIEWER_PM)).toBe(true);
    expect(canViewerSee('project_pm', VIEWER_ADMIN)).toBe(true);
  });

  it('tenant_admin は admin のみ (PM・member は不可)', () => {
    expect(canViewerSee('tenant_admin', VIEWER_GENERAL)).toBe(false);
    expect(canViewerSee('tenant_admin', VIEWER_MEMBER)).toBe(false);
    expect(canViewerSee('tenant_admin', VIEWER_PM)).toBe(false);
    expect(canViewerSee('tenant_admin', VIEWER_ADMIN)).toBe(true);
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
    // import カテゴリの tenant_admin 限定 FAQ は含まれていないこと。
    // ただし PR9 追加の 'import-sync-import-where' (= エンティティ別 sync-import) は
    // 一般メンバーも使える機能のため visibleTo='all' で開示される (許容)。
    const importAdminFaqs = result.filter(
      (e) => e.category === 'import' && e.id !== 'import-sync-import-where',
    );
    expect(importAdminFaqs.length).toBe(0);
  });

  it('一般メンバーは visibleTo=all の FAQ のみを受け取る (個別 entry 検証)', () => {
    const result = getFaqEntriesForRole(VIEWER_GENERAL);
    for (const e of result) {
      expect(e.visibleTo).toBe('all');
    }
  });

  it('PM/PL ロール持ちは all + project_member + project_pm を受け取る (tenant_admin 限定は除外)', () => {
    const result = getFaqEntriesForRole(VIEWER_PM);
    for (const e of result) {
      // PM/PL は project_member (作業者向け) も内包して見られる
      expect(['all', 'project_member', 'project_pm']).toContain(e.visibleTo);
    }
    // billing / admin / import (= tenant_admin 限定) は依然として除外
    expect(result.filter((e) => e.category === 'billing').length).toBe(0);
  });

  it('member (どこかのPで member 以上) は all + project_member を受け取る (project_pm / tenant_admin は除外)', () => {
    const result = getFaqEntriesForRole(VIEWER_MEMBER);
    for (const e of result) {
      expect(['all', 'project_member']).toContain(e.visibleTo);
    }
    // PM 限定 (参考タブ等) は含まれない
    expect(result.find((e) => e.id === 'reference-tab-howto')).toBeUndefined();
    // 作業者向け (課題作成等) は含まれる
    expect(result.find((e) => e.id === 'create-risk-issue-howto')).toBeDefined();
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

/**
 * PR9 (2026-05-29): 業務操作の詳細手順 FAQ を 22 件追加した invariant 検証。
 *   ユーザ指示: 「テナント管理者の初回ログイン時、CSV インポートの具体的手順を
 *   フクロウが返答できないと離脱防止が成り立たない」
 */
describe('PR9 業務操作の詳細手順 FAQ invariant', () => {
  it('FAQ 件数は 40 件以上 (PR9 で 20 → 42+)', () => {
    expect(FAQ_ENTRIES.length).toBeGreaterThanOrEqual(40);
  });

  it('CSV インポート関連 (3 種類のインポート機能) の id がすべて含まれる', () => {
    const expectedIds = [
      'import-features-overview', // 3 種類の整理
      'import-zip-tenant', // ZIP 一括取込
      'import-external-wizard-where-to-start', // 外部データ移行ウィザード起点
      'import-external-wizard-4steps-detail', // 4 ステップ詳細
      'import-sync-import-where', // エンティティ別 sync-import
    ];
    for (const id of expectedIds) {
      expect(FAQ_ENTRIES.find((e) => e.id === id)).toBeDefined();
    }
  });

  it('CSV カラム仕様 FAQ (visibility / knowledgeType / impact / 日付 / 改行 / 文字コード) がすべて含まれる', () => {
    const expectedIds = [
      'csv-knowledge-required-fields',
      'csv-knowledge-type-values',
      'csv-knowledge-visibility-mapping', // ★ユーザ指示: 「自分のみにしたい場合は draft」
      'csv-riskissue-required-fields',
      'csv-riskissue-type-values',
      'csv-riskissue-visibility-mapping',
      'csv-impact-priority-likelihood-values',
      'csv-date-format',
      'csv-multiline-cells',
      'csv-encoding',
      'csv-row-and-file-limits',
      'csv-error-recovery',
    ];
    for (const id of expectedIds) {
      expect(FAQ_ENTRIES.find((e) => e.id === id)).toBeDefined();
    }
  });

  it('★ユーザ指示★ visibility=draft (自分のみ) の設定方法を一般メンバーから隠す (tenant_admin 限定 = CSV 編集権限と一致)', () => {
    // CSV インポート系は全て tenant_admin 限定 (一般メンバーには CSV インポート権限がない)
    const csvFaqs = FAQ_ENTRIES.filter((e) => e.id.startsWith('csv-') || e.id.startsWith('import-'));
    const sharedToAll = csvFaqs.filter((e) => e.visibleTo === 'all');
    // sync-import (エンティティ別) は一般メンバーも使えるため visibility='all' 1 件のみ許容
    expect(sharedToAll.map((e) => e.id)).toEqual(['import-sync-import-where']);
  });

  it('MFA / パスワード要件 FAQ は全員に開示 (all)', () => {
    // MFA は一般メンバーも有効化できるため visibleTo='all'
    expect(FAQ_ENTRIES.find((e) => e.id === 'mfa-setup')?.visibleTo).toBe('all');
    expect(FAQ_ENTRIES.find((e) => e.id === 'mfa-recovery-code-lost')?.visibleTo).toBe('all');
    expect(FAQ_ENTRIES.find((e) => e.id === 'password-strength-requirement')?.visibleTo).toBe('all');
  });

  it('プラン変更・予算上限・90 日タイムライン・招待 FAQ は tenant_admin 限定 (料金漏洩防止)', () => {
    expect(FAQ_ENTRIES.find((e) => e.id === 'plan-upgrade-procedure')?.visibleTo).toBe('tenant_admin');
    expect(FAQ_ENTRIES.find((e) => e.id === 'budget-cap-setting')?.visibleTo).toBe('tenant_admin');
    expect(FAQ_ENTRIES.find((e) => e.id === 'beginner-90day-timeline')?.visibleTo).toBe('tenant_admin');
    expect(FAQ_ENTRIES.find((e) => e.id === 'invite-member-procedure')?.visibleTo).toBe('tenant_admin');
  });

  it('一般メンバーには CSV インポート詳細手順が漏れない (severity-1 情報漏洩防止)', () => {
    const general = getFaqEntriesForRole({
      isTenantAdmin: false,
      hasAnyProjectPmRole: false,
      hasAnyProjectMembership: false,
    });
    // tenant_admin 限定の CSV / インポート FAQ が一切含まれていないこと
    const csvAdminFaqs = general.filter(
      (e) => (e.id.startsWith('csv-') || e.id.startsWith('import-')) && e.id !== 'import-sync-import-where',
    );
    expect(csvAdminFaqs).toEqual([]);
  });
});

/**
 * PR9 (2026-05-29): buildRoleGuardancePromptSection の fail-open 防御強化。
 *   AI hallucination で「全権限ユーザだから何でも答えていい」と誤認させない invariant。
 */
describe('PR9 buildRoleGuardancePromptSection fail-open 防御', () => {
  it('全権限ユーザ向けでも「許可された FAQ/ガイドのみ」と中立的に伝える (制限なし宣言を回避)', () => {
    const guidance = buildRoleGuardancePromptSection({
      isTenantAdmin: true,
      hasAnyProjectPmRole: true,
      hasAnyProjectMembership: true,
    });
    expect(guidance).toContain('許可された FAQ');
    // 旧 fail-open フレーズが残っていないこと
    expect(guidance).not.toBe('本ユーザは全権限を持つため、開示制限はありません。');
  });

  it('権限制限がある場合、回答本文に金額・期間・上限値を「一切出さない」と AI に指示', () => {
    const guidance = buildRoleGuardancePromptSection({
      isTenantAdmin: false,
      hasAnyProjectPmRole: false,
      hasAnyProjectMembership: false,
    });
    // ★G2-a2★ 「短い謝罪 + 該当ロール誘導の 1 文のみ」。金額/期間/上限/操作手順は出さず、
    //   画面名・問い合わせ先・確認方法などの追加案内も付けない。
    expect(guidance).toContain('具体的な金額・期間・上限値・操作手順は一切含めず');
    expect(guidance).toContain('画面名・問い合わせ先・確認方法などの追加案内も付けず');
  });
});
