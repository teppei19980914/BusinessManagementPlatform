'use client';

/**
 * Stripe 支払い方法セクション (PR-S5 / 2026-05-14, PR #425 / 2026-05-21 改修)
 *
 * 役割 (PR #425 改修後):
 *   `/settings/tenant` の「支払い方法」セクション。**現在の支払い方法の表示と、
 *   クレジットカード情報の登録/更新ボタンの提供のみ** を担う。
 *
 *   支払い方法 (invoice / credit_card) の切替は別セクション (請求先情報フォーム) で
 *   `paymentMethod` セレクトボックス + 「請求先情報を更新」ボタンで行う。本セクションは
 *   その切替結果を読み取って表示・ボタン活性条件にする。
 *
 * 表示モデル (PR #425):
 *   - paymentMethod = 'invoice' 等: 「現在: 銀行振込」表示 + ボタン非活性
 *   - paymentMethod = 'credit_card':
 *       - stripeSubscriptionId = null: ボタン押下で Stripe Checkout setup (= 新規カード登録)
 *       - stripeSubscriptionId != null: ボタン押下で Stripe Customer Portal (= カード情報更新)
 *
 *   D 状態 (= カード期限切れ / 拒否 / autoSuspend 予定) のときは警告メッセージを併記。
 *
 * 親 (TenantSettingsClient) から渡されるもの:
 *   - info: 自テナントの Stripe 関連情報 (= paymentMethod / stripeSubscriptionId 等)
 *   - stripeEnabled: feature flag (= 環境変数 STRIPE_ENABLED の値)
 *   - onRefresh: アクション後にテナント情報を再取得するコールバック
 *
 * 関連:
 *   - 仕様: docs/specification/STRIPE_PAYMENT_UI.md §2 (PR #425 改修反映済)
 *   - API: src/app/api/tenants/me/billing/stripe/setup (新規登録) / portal (更新)
 *   - 切替元: tenant-settings-client.tsx BillingContactSection (paymentMethod セレクト)
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/toast-provider';

export type StripePaymentInfo = {
  paymentMethod: string;
  stripeCustomerId: string | null;
  /**
   * PR #425 (2026-05-21): null = カード未登録、非 null = カード登録済。
   * ボタン押下時の動作分岐に使用 (null → setup、非 null → portal)。
   */
  stripeSubscriptionId: string | null;
  stripeSubscriptionStatus: string | null;
  stripeDefaultPaymentMethodId: string | null;
  cardVerificationStatus: string | null;
  /** Server Component から渡る際に Date は ISO string になる */
  cardLastVerifiedAt: Date | string | null;
  autoSuspendScheduledAt: Date | string | null;
};

/**
 * PR #425 (2026-05-22): Stripe 登録カード情報サマリ。
 * 「画面に表示しているカード = 実際に請求されるカード」の一貫性を担保するため、
 * Stripe API から取得した値をそのまま使う (= キャッシュなし)。
 * PCI DSS 対象外の表示可能フィールドのみ含む (= 末尾 4 桁 + ブランド + 有効期限のみ)。
 */
export type StripeCardSummaryProp = {
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
};

export type StripePaymentMethodSectionProps = {
  info: StripePaymentInfo;
  /** feature flag。false なら「クレジットカード情報更新」ボタンは無効化 */
  stripeEnabled: boolean;
  /** アクション成功後に親の info を更新するためのコールバック */
  onRefresh: () => Promise<void>;
  /**
   * PR #425 (2026-05-22): Stripe 登録カード情報。null = 未登録 / API 失敗 / Stripe disabled。
   * テナント管理者が「このカードに毎月請求される」と画面で確認できるようにする。
   */
  cardSummary: StripeCardSummaryProp | null;
};

/**
 * PR #425 (2026-05-22): カードブランド表示用ラベル (Stripe API の brand 値からマッピング)。
 */
function formatCardBrand(brand: string): string {
  const map: Record<string, string> = {
    visa: 'Visa',
    mastercard: 'Mastercard',
    amex: 'American Express',
    jcb: 'JCB',
    diners: 'Diners Club',
    discover: 'Discover',
    unionpay: 'UnionPay',
  };
  return map[brand.toLowerCase()] ?? brand;
}

/**
 * PR #425 (2026-05-22): カード有効期限を MM/YY 形式で表示。
 */
function formatCardExpiry(expMonth: number, expYear: number): string {
  const mm = String(expMonth).padStart(2, '0');
  const yy = String(expYear).slice(-2);
  return `${mm}/${yy}`;
}

/**
 * 状態判定 (PR #425 改修後): paymentMethod と Stripe 状態から表示を決定する。
 *
 * - 'invoice_only': paymentMethod != 'credit_card' (= 銀行振込)
 *   → ボタン非活性、「銀行振込」表示
 * - 'credit_card_unregistered': paymentMethod = 'credit_card' かつ stripeSubscriptionId = null
 *   → ボタン活性 (新規カード登録 = setup へ)、「カード未登録」表示
 * - 'credit_card_active': paymentMethod = 'credit_card' + Subscription 有り + 検証成功 + autoSuspend 予定なし
 *   → ボタン活性 (情報更新 = portal へ)
 * - 'credit_card_attention': paymentMethod = 'credit_card' + Subscription 有り + 検証 NG or autoSuspend 予定あり
 *   → ボタン活性 (要対応、portal で更新を促す)
 *
 * 2026-05-15: 旧 'bank_transfer' は paymentMethod = 'invoice' に統合済。
 */
export type StripeUiState =
  | 'invoice_only'
  | 'credit_card_unregistered'
  | 'credit_card_active'
  | 'credit_card_attention';

export function deriveStripeState(info: StripePaymentInfo): StripeUiState {
  if (info.paymentMethod !== 'credit_card') return 'invoice_only';
  if (info.stripeSubscriptionId == null) return 'credit_card_unregistered';
  const verified = info.cardVerificationStatus === 'valid';
  const autoSuspendPending = info.autoSuspendScheduledAt != null;
  if (verified && !autoSuspendPending) return 'credit_card_active';
  return 'credit_card_attention';
}

export function StripePaymentMethodSection({
  info,
  stripeEnabled,
  onRefresh,
  cardSummary,
}: StripePaymentMethodSectionProps): React.ReactElement {
  const t = useTranslations('stripePaymentSection');
  const { showError } = useToast();
  const [submitting, setSubmitting] = useState(false);
  const state = deriveStripeState(info);
  const buttonActive = state !== 'invoice_only';

  /**
   * PR #425 (2026-05-22) ★severity-1 一貫性★: 「クレジットカード情報更新」ボタンのハンドラ。
   *
   * 旧: state によって Stripe Checkout setup (新規) or Customer Portal (= デフォルト変更) に分岐
   * 新: **常に Stripe Checkout setup に統一** (= ユーザの直感「カード変更 = カード入力画面」に合致)
   *
   * 理由: Customer Portal で「デフォルト変更」してもStripe 仕様上 既存 Subscription の
   *      `default_payment_method` は更新されない (= ユーザが Portal で Mastercard に変えても
   *      引落は Visa から、というズレ事故が発生)。
   *      本ハンドラは常に Stripe Checkout で新カードを入力させ、completeStripeSetup の
   *      「カード変更モード」 (= 既存 Subscription を維持しつつ default_payment_method を update)
   *      に統一する。これで「画面 = Customer Portal デフォルト = 実引落カード」3 点完全一致。
   */
  const handleClick = async () => {
    if (state === 'invoice_only') return;
    const confirmMsg =
      state === 'credit_card_unregistered'
        ? t('confirmRegister')
        : t('confirmUpdate');
    const ok = window.confirm(confirmMsg);
    if (!ok) return;
    await callSetup();
    await onRefresh();
  };

  const callSetup = async () => {
    setSubmitting(true);
    try {
      // feat/tenant-settings-tabs (2026-05-22): カード登録完了後は請求タブへ戻す。
      //   complete/route.ts:sanitizeReturnTo はクエリ込み URL を保持できる設計のため、
      //   ?tab=billing が剥がれることはない。
      const returnUrl = `${window.location.origin}/settings/tenant?tab=billing`;
      const res = await fetch('/api/tenants/me/billing/stripe/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ returnUrl }),
      });
      const json = await res.json();
      if (!res.ok) {
        showError(json?.error?.message ?? t('errorSetupFailed'));
        return;
      }
      if (json.data?.checkoutUrl == null) {
        showError(t('errorCheckoutUrl'));
        return;
      }
      window.location.href = json.data.checkoutUrl;
    } catch {
      showError(t('errorNetwork'));
    } finally {
      setSubmitting(false);
    }
  };

  // PR #425 (2026-05-22): 「クレジットカード払いが有効か」が一目で分かる表示に改善。
  //   状態バッジ (✅ 有効 / ⚠ 未登録 / ❌ 要対応 / 🏦 銀行振込) を currentLabel に明示。
  const currentLabel =
    state === 'invoice_only'
      ? t('stateInvoice')
      : state === 'credit_card_unregistered'
        ? t('stateCcUnregistered')
        : state === 'credit_card_active'
          ? t('stateCcActive')
          : t('stateCcAttention');

  const description =
    state === 'invoice_only'
      ? t('descInvoice')
      : state === 'credit_card_unregistered'
        ? t('descCcUnregistered')
        : state === 'credit_card_active'
          ? t('descCcActive')
          : '';

  return (
    <section
      className="space-y-3 rounded border bg-card p-4"
      aria-labelledby="stripe-payment-section-heading"
    >
      <h2 id="stripe-payment-section-heading" className="text-base font-semibold">
        {t('sectionTitle')}
      </h2>

      <div className="space-y-3 text-sm">
        <p>{t('currentPaymentMethod')}{currentLabel}</p>
        {description && <p className="text-muted-foreground">{description}</p>}

        {/* PR #425 (2026-05-22): Stripe 登録カード情報の可視化。
            「画面に出ているカード = 毎月引落されるカード」の一貫性を担保するため、
            Stripe API から取得した値 (brand/last4/exp) を表示する。
            cardSummary=null は「カード未登録」or「Stripe API 取得失敗」or「Stripe disabled」。
            ★severity-1 UX★ 銀行振込モード (= state==='invoice_only') のときは Stripe 側に
            カード履歴が残っていても表示しない (= 「画面のカード = 請求カード」一貫性の維持)。
            銀行振込時にカード情報を表示すると「カードに請求される?」とユーザが誤解する。 */}
        {cardSummary && state !== 'invoice_only' && (
          <div
            className="rounded border border-info/40 bg-info/5 p-3"
            data-testid="stripe-card-summary"
          >
            <p className="text-xs font-medium text-muted-foreground">{t('cardSummaryTitle')}</p>
            <p className="mt-1 font-mono text-sm">
              {formatCardBrand(cardSummary.brand)} •••• {cardSummary.last4}
              <span className="ml-3 text-muted-foreground">
                {t('cardExpiry')}{formatCardExpiry(cardSummary.expMonth, cardSummary.expYear)}
              </span>
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {t('cardAutoCharge')}
            </p>
          </div>
        )}
        {!cardSummary && state === 'credit_card_active' && (
          // 異常パターン: DB は credit_card_active なのに Stripe からカード取得できない
          // (= API 通信エラー / Stripe 側で detach 等)。請求漏れリスクなので明示警告。
          <div
            className="rounded border border-amber-300 bg-amber-50 p-3 text-sm dark:bg-amber-900/30"
            role="alert"
            data-testid="stripe-card-summary-missing"
          >
            <p className="font-semibold">{t('cardMissingTitle')}</p>
            <p className="text-muted-foreground">
              {t('cardMissingDesc')}
            </p>
          </div>
        )}

        {state === 'credit_card_attention' && (
          <div
            className="rounded border border-destructive/40 bg-destructive/10 p-3 text-sm"
            role="alert"
          >
            <p className="font-semibold text-destructive">{t('attentionTitle')}</p>
            <p className="text-muted-foreground">
              {info.cardVerificationStatus === 'expired' && t('attentionExpired')}
              {info.cardVerificationStatus === 'declined' && t('attentionDeclined')}
              {info.cardVerificationStatus === 'never_verified' && t('attentionNeverVerified')}
              {info.autoSuspendScheduledAt != null && t('attentionAutoSuspend')}
            </p>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            onClick={handleClick}
            disabled={!buttonActive || !stripeEnabled || submitting}
            aria-label={t('btnAriaLabel')}
          >
            {submitting ? t('btnProcessing') : t('btnUpdate')}
          </Button>
          {/* PR #425 (2026-05-22): 請求履歴閲覧リンク (既存の /settings/tenant/billing への遷移)。
              Customer Portal を撤去したため、請求履歴閲覧の導線をここに集約する。 */}
          <a
            href="/settings/tenant/billing"
            className="text-sm text-info underline"
          >
            {t('billingHistoryLink')}
          </a>
        </div>

        {!stripeEnabled && (
          <p className="text-xs text-muted-foreground">
            {t('stripeDisabledNote')}
          </p>
        )}
      </div>
    </section>
  );
}
