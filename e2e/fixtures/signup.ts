/**
 * E2E 公開セルフサインアップ ヘルパー (test/release-acceptance-e2e / 2026-06)
 *
 * 役割:
 *   `/signup` から新規テナントを **完全に払い出す** 一連の操作を spec から共通化する。
 *   既存の単発 spec (14-signup-3tier-eligibility) は「送信前の UI 判定」のみで送信完了まで
 *   踏み込まなかったが、本ヘルパーは inbox provider 経由で検証メールのトークンを取得し、
 *   パスワード設定 → ログイン → 初回オンボーディングモーダルの dismiss までを行う。
 *
 * フロー (全て UI 経由、メールは inbox provider を介して取得):
 *   1. /signup でフォーム全項目を入力 (plan / テナント情報 / 請求先 / 初期 admin / 同意)
 *   2. signup-submit → 成功画面 (signup-success-email) を待つ
 *   3. inbox から initialAdminEmail 宛ての招待メールを取得し setup-password トークン URL を抽出
 *   4. /setup-password でパスワードを設定 (admin は MFA 任意 = 即 done)
 *   5. /login で 組織 ID(slug) + email + password でログイン → /projects 着地
 *   6. 初回ログインで自動表示される WelcomeOwlModal (#475 / G2-e-3) を welcome-owl-close で閉じる
 *      (isFirstTimeUser = priorLoginSuccessCount === 0 のため、新規払い出し直後の初回ログインで必ず出る)
 *
 * 一意性 / クリーンアップ:
 *   email / slug / tenantName は全て RUN_ID prefix を含むため、afterAll の
 *   cleanupTenantByRunId(RUN_ID) (e2e/fixtures/db.ts) で物理 purge できる。
 *   ※ セルフ解約は論理削除 + abuse 防止で user/tenant 行が残るため、テスト後始末は物理 purge が必須。
 *
 * 関連:
 *   - UI: src/app/(auth)/signup/page.tsx / src/app/(auth)/setup-password/page.tsx
 *   - メール取得: e2e/fixtures/inbox.ts (waitForMail / extractSetupPasswordUrl / extractToken)
 *   - オンボーディング: src/components/onboarding/welcome-owl-modal.tsx
 *   - カバレッジ: docs/test/E2E_COVERAGE.md (/signup 完了 / /api/auth/signup)
 */

import { expect, type Page } from '@playwright/test';
import { withRunId } from './run-id';
import { waitForMail, extractSetupPasswordUrl, extractToken } from './inbox';

export type SignupPlan = 'beginner' | 'expert' | 'pro';

export type SignupResult = {
  /** 初期 admin = ログイン用メール (RUN_ID prefix 付き、層3 を保証) */
  email: string;
  /** 組織 ID (slug、ログイン時の組織 ID 入力に使用) */
  slug: string;
  /** 設定したパスワード */
  password: string;
  /** 表示用テナント名 (セルフ解約の名称一致確認で使用) */
  tenantName: string;
  /** 初期 admin の氏名 */
  adminName: string;
  /** 実際に払い出されたプラン */
  plan: SignupPlan;
};

export type SignupOptions = {
  /** 払い出すプラン (既定 beginner)。層3 の fresh email では全プラン選択可。 */
  plan?: SignupPlan;
  /** RUN_ID 内のサブラベル (email / slug / tenantName を spec ごとに分離する)。既定 'tenant'。 */
  label?: string;
  /** 設定パスワード (既定の強パスワードで十分なため通常は省略)。 */
  password?: string;
  /** 請求先種別 (既定 corporate)。 */
  billingType?: 'corporate' | 'individual';
  /**
   * 既に存在する email を使う場合 (層2/層1 検証用) はここに指定。
   * 未指定なら RUN_ID から fresh email を生成する (= 層3)。
   */
  emailOverride?: string;
  /**
   * true の場合、初回ログイン後に自動表示される WelcomeOwlModal を **閉じずに返す**。
   * オンボーディング spec が「自動表示されること」を検証する用途。既定 false (= 閉じる)。
   */
  skipOnboardingDismiss?: boolean;
};

const DEFAULT_PASSWORD = 'E2eTenant!Pw_2026';

/** RUN_ID から slug 規約 (英小文字数字ハイフン / 3-60 / 端は英数) に適合する slug を作る。 */
function buildSlug(label: string): string {
  const raw = withRunId(label).toLowerCase().replace(/[^a-z0-9-]/g, '-');
  // 端のハイフンを除去し 60 文字に収める (RUN_ID 構成上通常 ~35 文字)
  return raw.replace(/^-+/, '').replace(/-+$/, '').slice(0, 60).replace(/-+$/, '');
}

/**
 * /signup → setup-password → login → オンボーディング dismiss を行い、払い出した
 * テナントの認証情報を返す。返却後はダッシュボード (/projects) に居る。
 */
export async function signupTenantViaUi(
  page: Page,
  options: SignupOptions = {},
): Promise<SignupResult> {
  const plan: SignupPlan = options.plan ?? 'beginner';
  const label = options.label ?? 'tenant';
  const password = options.password ?? DEFAULT_PASSWORD;
  const billingType = options.billingType ?? 'corporate';
  const email = (options.emailOverride ?? `${withRunId(label)}@example.com`).toLowerCase();
  const slug = buildSlug(label);
  const tenantName = withRunId(`${label}-テナント`);
  const adminName = withRunId(`${label}-管理者`);

  // ---------- 1. /signup フォーム入力 ----------
  await page.goto('/signup');
  await page.waitForLoadState('networkidle');

  // プラン選択 (beginner は既定で選択済。expert/pro は radio を選ぶ)
  if (plan !== 'beginner') {
    const planName = plan === 'expert' ? /Expert/ : /Pro/;
    await page.getByRole('radio', { name: planName }).check();
  }

  await page.locator('#name').fill(tenantName);
  await page.locator('#slug').fill(slug);

  // 請求先
  // feat/billing-conditional-by-plan (2026-06-05): Beginner は請求先セクションが非表示になり、
  //   請求先担当者名・メールは初期管理者の値で自動補完されるため、ここでは入力しない。
  //   Expert/Pro のみ請求先フォームが表示され、住所まで入力する。
  if (plan !== 'beginner') {
    if (billingType === 'individual') {
      await page.getByRole('radio', { name: '個人' }).check();
    } else {
      await page.locator('#billingCompanyName').fill(withRunId(`${label}-会社`));
    }
    await page.locator('#billingContactName').fill(adminName);
    await page.locator('#billingContactEmail').fill(email);
    await page.locator('#billingPostalCode').fill('100-0001');
    await page.locator('#billingPrefecture').fill('東京都');
    await page.locator('#billingCity').fill('千代田区');
    await page.locator('#billingStreetAddress').fill('千代田1-1');
  }

  // 初期 admin
  await page.locator('#initialAdminName').fill(adminName);
  await page.locator('#initialAdminEmail').fill(email);

  // ADR-0016 Revised: initialAdminEmail 入力後 300ms debounce で eligibility 判定が走る。
  //   fresh な RUN_ID email は層3 (signupAllowed=true / beginnerAvailable=true) になるため、
  //   plan が勝手に expert へ切替わることはない。判定が落ち着くまで待つ。
  if (plan === 'beginner') {
    await expect(page.getByRole('radio', { name: /Beginner/ })).toBeEnabled();
  }
  await expect(page.getByTestId('owned-tenant-warning')).toBeHidden();

  // 同意
  await page.getByTestId('signup-accept-terms').check();
  await page.getByTestId('signup-accept-privacy').check();

  // 送信
  const submit = page.getByTestId('signup-submit');
  await expect(submit).toBeEnabled();
  await submit.click();

  // 成功画面 (送信先メールアドレスが表示される)
  await expect(page.getByTestId('signup-success-email')).toHaveText(email, { timeout: 15_000 });

  // ---------- 2. inbox から招待メール → setup-password トークン ----------
  const mail = await waitForMail(email, { timeoutMs: 15_000 });
  const setupUrl = extractSetupPasswordUrl(mail);
  const token = extractToken(setupUrl);

  // ---------- 3. /setup-password でパスワード設定 ----------
  // 絶対 URL の NEXTAUTH_URL とテスト baseURL 差異を避けるため、token のみ取り出して相対遷移する。
  await page.goto(`/setup-password?token=${encodeURIComponent(token)}`);
  await page.locator('#password').fill(password);
  await page.locator('#confirmPassword').fill(password);
  // admin (super_admin 以外) は MFA 任意 = パスワード設定で即 done。i18n 文言非依存に submit を選ぶ。
  await page.locator('form button[type="submit"]').click();
  // done ステップ = リカバリーコード + 「ログイン画面へ」ボタンが出る
  await expect(page.getByRole('button', { name: /ログイン/ })).toBeVisible({ timeout: 15_000 });

  // ---------- 4. /login でログイン ----------
  await page.goto('/login');
  await page.getByLabel('組織 ID').fill(slug);
  await page.getByLabel('メールアドレス').fill(email);
  await page.getByLabel('パスワード').fill(password);
  await page.getByRole('button', { name: 'ログイン', exact: true }).click();
  await page.waitForURL('**/projects', { timeout: 15_000 });
  await page.waitForLoadState('networkidle');

  // ---------- 5. 初回オンボーディングモーダルを閉じる ----------
  //   #475 (G2-e-3): isFirstTimeUser=true の初回ログインで WelcomeOwlAutoOpen が自動展開する。
  //   画面を覆うため、以降の操作の前に必ず閉じる (オンボーディング検証 spec は skip して自前で閉じる)。
  if (!options.skipOnboardingDismiss) {
    await dismissWelcomeOwlModalIfPresent(page);
  }

  return { email, slug, password, tenantName, adminName, plan };
}

/**
 * 初回オンボーディングモーダル (welcome-owl-modal) が表示されていれば閉じる。
 * 表示されないケース (再ログイン等) では何もしない (= 冪等)。
 */
export async function dismissWelcomeOwlModalIfPresent(page: Page): Promise<void> {
  const modal = page.getByTestId('welcome-owl-modal');
  await modal.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {});
  if (await modal.isVisible().catch(() => false)) {
    await page.getByTestId('welcome-owl-close').click();
    await modal.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {});
  }
}
