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
  const { showError } = useToast();
  const [submitting, setSubmitting] = useState(false);
  const state = deriveStripeState(info);
  const buttonActive = state !== 'invoice_only';
  // 押下時の動作: Subscription 未作成 → setup、作成済 → portal
  const action: 'setup' | 'portal' | 'disabled' =
    state === 'invoice_only'
      ? 'disabled'
      : state === 'credit_card_unregistered'
        ? 'setup'
        : 'portal';

  /**
   * 「クレジットカード情報更新」ボタンのハンドラ。
   * state に応じて Stripe Checkout setup or Customer Portal に分岐。
   */
  const handleClick = async () => {
    if (action === 'disabled') return;
    if (action === 'setup') {
      const ok = window.confirm(
        '新しいクレジットカードを登録しますか?\n\n' +
          '次の画面 (Stripe Checkout) でカード情報を入力してください。\n' +
          '検証成功時は自動的にカード払いの引落準備が完了します。\n' +
          '失敗 / キャンセル時は支払い方法はクレジットカード設定のままです (カード未登録)。',
      );
      if (!ok) return;
      await callSetup();
    } else {
      await callPortal();
    }
    await onRefresh();
  };

  const callSetup = async () => {
    setSubmitting(true);
    try {
      const returnUrl = `${window.location.origin}/settings/tenant`;
      const res = await fetch('/api/tenants/me/billing/stripe/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ returnUrl }),
      });
      const json = await res.json();
      if (!res.ok) {
        showError(json?.error?.message ?? 'カード登録の開始に失敗しました');
        return;
      }
      if (json.data?.checkoutUrl == null) {
        showError('Stripe Checkout URL の取得に失敗しました');
        return;
      }
      window.location.href = json.data.checkoutUrl;
    } catch {
      showError('通信エラーが発生しました');
    } finally {
      setSubmitting(false);
    }
  };

  const callPortal = async () => {
    setSubmitting(true);
    try {
      const returnUrl = `${window.location.origin}/settings/tenant`;
      const res = await fetch('/api/tenants/me/billing/stripe/portal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ returnUrl }),
      });
      const json = await res.json();
      if (!res.ok) {
        showError(json?.error?.message ?? 'ポータル URL の取得に失敗しました');
        return;
      }
      if (json.data?.portalUrl == null) {
        showError('Stripe ポータル URL の取得に失敗しました');
        return;
      }
      window.open(json.data.portalUrl, '_blank', 'noopener,noreferrer');
    } catch {
      showError('通信エラーが発生しました');
    } finally {
      setSubmitting(false);
    }
  };

  // PR #425 (2026-05-22): 「クレジットカード払いが有効か」が一目で分かる表示に改善。
  //   状態バッジ (✅ 有効 / ⚠ 未登録 / ❌ 要対応 / 🏦 銀行振込) を currentLabel に明示。
  const currentLabel =
    state === 'invoice_only'
      ? '🏦 銀行振込'
      : state === 'credit_card_unregistered'
        ? '⚠ クレジットカード払い (カード未登録 = 自動請求不可)'
        : state === 'credit_card_active'
          ? '✅ クレジットカード払い (有効・自動引落)'
          : '❌ クレジットカード払い (要対応 = 引落停止リスクあり)';

  const description =
    state === 'invoice_only'
      ? '月末締めの翌月25日支払で、毎月請求書 PDF を請求担当者メールにお送りしています。' +
        ' クレジットカード払いに切替えるには、上の請求先情報フォームで「支払い方法」を' +
        '「クレジットカード」に変更して「請求先情報を更新」を押してください (自動でカード登録画面に進みます)。'
      : state === 'credit_card_unregistered'
        ? '★ご注意★ 支払い方法はクレジットカードに設定されていますが、まだカードが登録されていないため自動請求できません。' +
          ' 「クレジットカード情報更新」ボタンから今すぐ登録してください。'
        : state === 'credit_card_active'
          ? '毎月末締めで Stripe が自動的に利用料を集計し、翌月初に登録カードから引き落とします。' +
            ' 領収書 PDF は Stripe から自動メール送付されます。'
          : '';

  return (
    <section
      className="space-y-3 rounded border bg-card p-4"
      aria-labelledby="stripe-payment-section-heading"
    >
      <h2 id="stripe-payment-section-heading" className="text-base font-semibold">
        支払い方法
      </h2>

      <div className="space-y-3 text-sm">
        <p>現在の支払い方法: {currentLabel}</p>
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
            <p className="text-xs font-medium text-muted-foreground">請求に使用されるカード (Stripe 登録情報)</p>
            <p className="mt-1 font-mono text-sm">
              {formatCardBrand(cardSummary.brand)} •••• {cardSummary.last4}
              <span className="ml-3 text-muted-foreground">
                有効期限 {formatCardExpiry(cardSummary.expMonth, cardSummary.expYear)}
              </span>
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              このカードに毎月の利用料が自動引落されます。
              変更したい場合は「クレジットカード情報更新」ボタンをご利用ください。
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
            <p className="font-semibold">⚠ カード情報を Stripe から取得できませんでした</p>
            <p className="text-muted-foreground">
              ネットワーク一時障害の可能性があります。少し待ってからページを再読込してください。
              繰り返し表示される場合は「クレジットカード情報更新」からカード再登録をお願いします。
            </p>
          </div>
        )}

        {state === 'credit_card_attention' && (
          <div
            className="rounded border border-destructive/40 bg-destructive/10 p-3 text-sm"
            role="alert"
          >
            <p className="font-semibold text-destructive">⚠️ カードの状態を確認してください</p>
            <p className="text-muted-foreground">
              {info.cardVerificationStatus === 'expired' &&
                'カードの有効期限が切れています。Stripe ポータルからカード情報を更新してください。'}
              {info.cardVerificationStatus === 'declined' &&
                'カードが拒否されています。別のカードへの変更を Stripe ポータルから行ってください。'}
              {info.cardVerificationStatus === 'never_verified' &&
                'カードがまだ検証されていません。Stripe ポータルでカードを確認してください。'}
              {info.autoSuspendScheduledAt != null &&
                ' 引落失敗が続いており、まもなくサービスが自動停止する予定です。'}
            </p>
          </div>
        )}

        <Button
          type="button"
          onClick={handleClick}
          disabled={!buttonActive || !stripeEnabled || submitting}
          aria-label="クレジットカード情報更新"
        >
          {submitting ? '処理中...' : '💳 クレジットカード情報更新'}
        </Button>

        {!stripeEnabled && (
          <p className="text-xs text-muted-foreground">
            ※ クレジットカード払いは現在準備中です (運営による有効化待ち)。
          </p>
        )}
      </div>
    </section>
  );
}
