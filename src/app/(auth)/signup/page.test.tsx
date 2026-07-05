/**
 * SignupPage の構造 invariant 回帰テスト
 * (feat/signup-friction-reduction / 2026-06-12)
 *
 * 採用理由:
 *   vitest 設定が environment='node' で jsdom 非導入のため、他 component test と同様に
 *   ソース文字列上の invariant で「何を表示し / どの順序か / 実メールと一致するか」を縛る。
 *   slug 生成ロジック自体の振る舞いは src/lib/slug.test.ts で別途検証している。
 *
 * 検証観点:
 *   - A1: 組織 ID はサーバ自動採番 (入力欄なし / 自動採番の案内 / 成功画面で採番値を表示 / 再送に使用)
 *   - A3: 送信後画面の「メール予告」が実メール (email-verification.service.ts) と一致
 *   - B1: セクション順 = 組織情報 → 初期管理者 → プラン選択 → 請求先
 *   - eligibility 3 層制御 (層1 警告 / 層2 Beginner disable) が維持されている
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PAGE_FILE = join(__dirname, 'page.tsx');
const source = readFileSync(PAGE_FILE, 'utf8');

const JA_CATALOG = readFileSync(
  join(__dirname, '../../../i18n/messages/ja.json'),
  'utf8',
);

describe('A1: 組織 ID はサーバ自動採番 (入力欄なし)', () => {
  it('組織 ID (slug) の入力欄を持たない', () => {
    expect(source).not.toContain('id="slug"');
    expect(source).not.toContain('data-testid="signup-slug"');
    // FormState からも slug を除去している
    expect(source).not.toMatch(/form\.slug/);
  });

  it('組織 ID が自動発行される旨を案内する', () => {
    expect(source).toContain('data-testid="signup-org-id-auto-note"');
    expect(JA_CATALOG).toContain('自動で発行されます');
  });

  it('送信成功時に採番された組織 ID を受け取り、成功画面に表示する', () => {
    expect(source).toContain('setAssignedSlug');
    expect(source).toContain('data-testid="signup-success-slug"');
    expect(JA_CATALOG).toContain('あなたの組織 ID');
  });

  it('招待メール再送は採番された組織 ID (assignedSlug) を使う', () => {
    expect(source).toMatch(/tenantSlug:\s*assignedSlug/);
  });
});

describe('A3: 送信後画面のメール予告 (実メールと一致)', () => {
  it('予告ブロック (signup-email-expectation) を持つ', () => {
    expect(source).toContain('data-testid="signup-email-expectation"');
  });

  it('差出人・件名は email-verification.service.ts の実値と一致', () => {
    // 差出人アドレス (ソース内にハードコード維持)
    expect(source).toContain('noreply@tasukiba.com');
    // 件名 (カタログに移動)
    expect(JA_CATALOG).toContain('たすきば - アカウントの設定');
  });

  it('到着目安と有効期限 (24 時間) を予告する', () => {
    expect(JA_CATALOG).toContain('1 分以内');
    expect(JA_CATALOG).toContain('24 時間');
  });
});

describe('B1: セクション順 = 組織情報 → 初期管理者 → プラン選択 → 請求先', () => {
  it('legend の出現順が並べ替え後の順序になっている', () => {
    // i18n 化後はリテラルがカタログへ移動したため、ソース内のキー参照の出現順で検証する
    const tenant = source.indexOf("signup.orgInfoLegend");
    const admin = source.indexOf("signup.adminLegend");
    const plan = source.indexOf("signup.planLegend");
    const billing = source.indexOf("signup.billingLegend");

    expect(tenant).toBeGreaterThan(-1);
    expect(admin).toBeGreaterThan(-1);
    expect(plan).toBeGreaterThan(-1);
    expect(billing).toBeGreaterThan(-1);

    expect(tenant).toBeLessThan(admin);
    expect(admin).toBeLessThan(plan);
    expect(plan).toBeLessThan(billing);
  });

  it('請求先情報は Beginner 以外のときだけ表示する (条件レンダリング維持)', () => {
    expect(source).toContain("{form.plan !== 'beginner' && (");
  });
});

describe('eligibility 3 層制御の維持', () => {
  it('層1: signupAllowed=false の警告 (owned-tenant-warning) と submit disable', () => {
    expect(source).toContain('data-testid="owned-tenant-warning"');
    expect(source).toContain('!signupAllowed');
  });

  it('層2: beginnerAvailable=false で Beginner radio を disable', () => {
    expect(source).toContain('disabled={beginnerAvailable === false}');
    expect(source).toContain('data-testid="beginner-unavailable-hint"');
  });

  it('initialAdminEmail をキーに check-tenant-eligibility を呼ぶ', () => {
    expect(source).toContain('/api/auth/check-tenant-eligibility');
    expect(source).toContain('form.initialAdminEmail');
  });
});

describe('LP からの ?plan= 事前選択 (feat/signup-plan-preselect)', () => {
  it('useSearchParams で plan クエリを読み取り、Suspense でラップする (login/page.tsx と同パターン)', () => {
    expect(source).toContain("useSearchParams } from 'next/navigation'");
    expect(source).toContain('searchParams.get(\'plan\')');
    expect(source).toMatch(/<Suspense>\s*<SignupForm \/>\s*<\/Suspense>/);
  });

  it('plan クエリはホワイトリスト検証し、範囲外の値は beginner にフォールバックする', () => {
    expect(source).toContain(
      "const ALLOWED_PLANS = ['beginner', 'expert', 'pro'] as const;",
    );
    expect(source).toMatch(/resolveInitialPlan[\s\S]*?:\s*'beginner';/);
  });
});
