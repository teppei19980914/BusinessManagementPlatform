/**
 * クレジットカード払い「調整中」状態の退行防止テスト
 * (feat/credit-card-pending / 2026-05-26).
 *
 * 背景:
 *   Stripe 連携の最終調整中のため、UI 上はクレジットカード払いを **選択不可** にしている。
 *   ただし DB 側 / API 側 / Stripe 連携コード自体は維持し、再活性化時に disabled 属性を
 *   外すだけで運用復帰できるよう設計している。
 *
 * 本テストは「気付かないうちに有効化される」退行を防ぐためのインバリアント検査:
 *
 *   1. tenant-settings-client.tsx: テナント管理者が請求先情報フォームから選ぶ select
 *      (= 一般顧客が触る経路) で credit_card option が disabled 状態
 *   2. tenant-create-form.tsx: super_admin がテナント作成時に選ぶ select で
 *      credit_card option が disabled 状態
 *
 * 再活性化時の手順:
 *   - 各 source file から `disabled` 属性を削除
 *   - ラベル「クレジットカード (調整中)」を「クレジットカード」に戻す
 *   - 本テスト ファイル全体を削除
 *
 * source-pattern 検証である理由:
 *   vitest 環境は jsdom 非導入のため Component レンダリングを直接テストできない。
 *   AppFooter / AppHeader 等の他コンポーネントと同じ「source 文字列 invariant」方式を採用。
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

const tenantSettingsSource = readFileSync(TENANT_SETTINGS_FILE, 'utf8');
const tenantCreateFormSource = readFileSync(TENANT_CREATE_FORM_FILE, 'utf8');

describe('クレジットカード払い 調整中 UI invariant (feat/credit-card-pending)', () => {
  it('tenant-settings-client.tsx: credit_card option は disabled + 「(調整中)」表記', () => {
    // 完全一致ではなく緩めに「disabled」属性と「(調整中)」表記の存在を確認する。
    // optionalな属性順序の差 (disabled の位置等) を許容するため正規表現を使う。
    expect(tenantSettingsSource).toMatch(
      /<option\s+value="credit_card"\s+disabled\s*>\s*クレジットカード\s*\(調整中\)/,
    );
  });

  it('tenant-settings-client.tsx: credit_card option が無条件 enable に戻されていない', () => {
    // 退行検知: `<option value="credit_card">クレジットカード</option>` (disabled 無し)
    // が登場した場合に fail する。
    expect(tenantSettingsSource).not.toMatch(
      /<option\s+value="credit_card"\s*>\s*クレジットカード\s*</,
    );
  });

  it('tenant-create-form.tsx: credit_card option は disabled + 「(調整中)」表記', () => {
    expect(tenantCreateFormSource).toMatch(
      /<option\s+value="credit_card"\s+disabled\s*>\s*クレジットカード\s*\(調整中\)/,
    );
  });

  it('tenant-create-form.tsx: 旧「(今後対応予定)」表記が残っていない (表記統一)', () => {
    // テナント設定画面側 ("(調整中)") と表記揃え。再活性化時は両方の文言を同時に戻す。
    expect(tenantCreateFormSource).not.toMatch(/今後対応予定/);
  });

  it('両ファイル: 銀行振込 (invoice) option は常時 enable のまま (誤って無効化していない)', () => {
    expect(tenantSettingsSource).toMatch(/<option\s+value="invoice"\s*>\s*銀行振込/);
    expect(tenantCreateFormSource).toMatch(/<option\s+value="invoice"\s*>\s*銀行振込/);
  });
});

describe('クレジットカード払い API 側の維持 (= 再活性化時にコード変更不要)', () => {
  it('tenant-settings-client.tsx: credit_card 経路の処理コード (handleSubmit 等) は残存している', () => {
    // 表示だけ "調整中" にし、API 側ロジックは維持する設計。
    // `previousPaymentMethod !== 'credit_card'` のような判定が消えていないことを確認。
    expect(tenantSettingsSource).toMatch(/previousPaymentMethod\s*!==\s*['"]credit_card['"]/);
  });

  it('stripe-payment-method-section.tsx: deriveStripeState の credit_card 分岐は維持', () => {
    const stripeSectionFile = join(__dirname, 'stripe-payment-method-section.tsx');
    const source = readFileSync(stripeSectionFile, 'utf8');
    // credit_card_unregistered / credit_card_active / credit_card_attention 状態が残っている
    expect(source).toMatch(/credit_card_unregistered/);
    expect(source).toMatch(/credit_card_active/);
    expect(source).toMatch(/credit_card_attention/);
  });
});
