/**
 * クレジットカード払い UI ガード source-pattern 検証
 * (feat/credit-card-ui-guard / 2026-05-30 / KDD §5.X+184).
 *
 * 背景:
 *   STRIPE_ENABLED=false の場合、サーバ側 (`/api/tenants/me/billing/stripe/setup`) は
 *   403 STRIPE_DISABLED を返す。しかしクライアント側で credit_card option を選択させて
 *   しまうと「UI で選べるのに保存すると 403」という UX 矛盾が発生する。
 *
 *   本テストは「サーバ側 feature flag と UI option の整合性を担保する二段ガード」が
 *   コード上に存在することを source-pattern で確認する。
 *
 * 退行リスク:
 *   - 将来「UI 簡素化のため」と称して `disabled={!stripeEnabled}` を削除されると、
 *     STRIPE_ENABLED=false の本番環境で credit_card 選択 → 403 のフローが再発する。
 *   - 既に PR #469 で credit-card-pending.test.ts を削除した経緯あり (= 旧「無条件 disable」
 *     を解除)。本テストは「条件付き disable」を新たな invariant として固定する。
 *
 * source-pattern 検証である理由:
 *   vitest 環境は jsdom 非導入のため Component レンダリングを直接テストできない。
 *   AppFooter / AppHeader / 旧 credit-card-pending.test.ts と同じ「source 文字列 invariant」方式。
 *
 * 関連:
 *   - サーバ側 403 ガード: src/app/api/tenants/me/billing/stripe/setup/route.ts:50-59
 *   - UI ガード: src/app/(dashboard)/settings/tenant/tenant-settings-client.tsx
 *               src/app/(dashboard)/admin/super/tenants/new/tenant-create-form.tsx
 *   - KDD §5.X+184: Feature flag × UI option の二段ガード設計
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const TENANT_SETTINGS_FILE = join(__dirname, 'tenant-settings-client.tsx');
const TENANT_CREATE_FORM_FILE = join(
  __dirname,
  '..',
  '..',
  'admin',
  'super',
  'tenants',
  'new',
  'tenant-create-form.tsx',
);
const TENANT_CREATE_PAGE_FILE = join(
  __dirname,
  '..',
  '..',
  'admin',
  'super',
  'tenants',
  'new',
  'page.tsx',
);

const tenantSettingsSource = readFileSync(TENANT_SETTINGS_FILE, 'utf8');
const tenantCreateFormSource = readFileSync(TENANT_CREATE_FORM_FILE, 'utf8');
const tenantCreatePageSource = readFileSync(TENANT_CREATE_PAGE_FILE, 'utf8');

describe('クレジットカード払い UI ガード (feat/credit-card-ui-guard / 二段ガード設計)', () => {
  it('tenant-settings-client.tsx: BillingContactSection が stripeEnabled prop を受け取る', () => {
    // BillingContactSection の引数に stripeEnabled が宣言されている (= 親から伝搬される)
    expect(tenantSettingsSource).toMatch(
      /function\s+BillingContactSection\s*\(\s*\{[\s\S]*?stripeEnabled[\s\S]*?\}/,
    );
  });

  it('tenant-settings-client.tsx: TenantSettingsClient が BillingContactSection に stripeEnabled を渡す', () => {
    // <BillingContactSection ... stripeEnabled={stripeEnabled} ... /> の形が存在
    expect(tenantSettingsSource).toMatch(
      /<BillingContactSection[\s\S]*?stripeEnabled=\{stripeEnabled\}/,
    );
  });

  it('tenant-settings-client.tsx: credit_card option は !stripeEnabled で動的 disable される', () => {
    expect(tenantSettingsSource).toMatch(
      /<option\s+value="credit_card"\s+disabled=\{!stripeEnabled\}/,
    );
  });

  it('tenant-settings-client.tsx: stripeEnabled=false 時のラベルに「準備中」表記がある (UX 明示)', () => {
    expect(tenantSettingsSource).toMatch(/クレジットカード \(準備中\)/);
  });

  it('tenant-create-form.tsx: TenantCreateForm が stripeEnabled prop を受け取る', () => {
    expect(tenantCreateFormSource).toMatch(
      /export\s+function\s+TenantCreateForm\s*\(\s*\{[\s\S]*?stripeEnabled[\s\S]*?\}/,
    );
  });

  it('tenant-create-form.tsx: credit_card option は !stripeEnabled で動的 disable される', () => {
    expect(tenantCreateFormSource).toMatch(
      /<option\s+value="credit_card"\s+disabled=\{!stripeEnabled\}/,
    );
  });

  it('tenant-create-form.tsx: stripeEnabled=false 時のラベルに「準備中」表記がある', () => {
    expect(tenantCreateFormSource).toMatch(/クレジットカード \(準備中\)/);
  });

  it('page.tsx (admin/super/tenants/new): isStripeEnabled() を呼んで TenantCreateForm に渡す', () => {
    // Server Component で env を解決してから Client Component に伝搬する設計
    expect(tenantCreatePageSource).toMatch(/import\s+\{[\s\S]*?isStripeEnabled[\s\S]*?\}\s+from\s+['"]@\/lib\/stripe['"]/);
    expect(tenantCreatePageSource).toMatch(/isStripeEnabled\(\)/);
    expect(tenantCreatePageSource).toMatch(
      /<TenantCreateForm[\s\S]*?stripeEnabled=\{stripeEnabled\}/,
    );
  });
});

describe('退行検知: 旧「無条件 enable」が復活していない', () => {
  it('tenant-settings-client.tsx: 無条件 enable な credit_card option がない', () => {
    // disabled 属性のない `<option value="credit_card">クレジットカード</option>` (改行なし末端閉じ) が登場したら fail
    expect(tenantSettingsSource).not.toMatch(
      /<option\s+value="credit_card"\s*>\s*クレジットカード\s*<\/option>/,
    );
  });

  it('tenant-create-form.tsx: 無条件 enable な credit_card option がない', () => {
    expect(tenantCreateFormSource).not.toMatch(
      /<option\s+value="credit_card"\s*>\s*クレジットカード\s*<\/option>/,
    );
  });
});

describe('整合性: 銀行振込 (invoice) は常に enable のまま', () => {
  it('tenant-settings-client.tsx: invoice option は無条件 enable', () => {
    expect(tenantSettingsSource).toMatch(/<option\s+value="invoice"\s*>\s*銀行振込/);
  });

  it('tenant-create-form.tsx: invoice option は無条件 enable', () => {
    expect(tenantCreateFormSource).toMatch(/<option\s+value="invoice"\s*>\s*銀行振込/);
  });
});
