'use client';

/**
 * Stripe 支払い方法セクション (PR-S5 / 2026-05-14)
 *
 * 役割:
 *   `/settings/tenant` の「支払い方法」セクション。現状の paymentMethod に応じて
 *   状態 A / C / D を表示し、Checkout (= カード登録 + 切替) / Customer Portal / invoice 復帰の
 *   3 つのアクションを提供する。
 *
 * 状態モデル (STRIPE_PAYMENT_UI.md §2.2):
 *   - A (未設定): paymentMethod = 'invoice' or 'bank_transfer'
 *   - C (運用中): paymentMethod = 'credit_card' + cardVerificationStatus = 'valid'
 *   - D (要対応): paymentMethod = 'credit_card' + cardVerificationStatus != 'valid' or autoSuspendScheduledAt != null
 *
 * 親 (TenantSettingsClient) から渡されるもの:
 *   - info: 自テナントの Stripe 関連情報
 *   - stripeEnabled: feature flag (= 環境変数 STRIPE_ENABLED の値)
 *   - onRefresh: アクション後にテナント情報を再取得するコールバック
 *
 * 関連:
 *   - 仕様: docs/specification/STRIPE_PAYMENT_UI.md §2
 *   - API: src/app/api/tenants/me/billing/stripe/*
 */

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/toast-provider';

export type StripePaymentInfo = {
  paymentMethod: string;
  stripeCustomerId: string | null;
  stripeSubscriptionStatus: string | null;
  stripeDefaultPaymentMethodId: string | null;
  cardVerificationStatus: string | null;
  /** Server Component から渡る際に Date は ISO string になる */
  cardLastVerifiedAt: Date | string | null;
  autoSuspendScheduledAt: Date | string | null;
};

export type StripePaymentMethodSectionProps = {
  info: StripePaymentInfo;
  /** feature flag。false なら「クレジットカード払いに切替」ボタンは無効化 */
  stripeEnabled: boolean;
  /** アクション成功後に親の info を更新するためのコールバック */
  onRefresh: () => Promise<void>;
};

/**
 * 状態判定: A / C / D のいずれか。
 *
 * - 'A_invoice': 銀行振込（請求書送付）= credit_card 以外の全値 (= 旧 'bank_transfer' 含む)
 * - 'C_active': credit_card + 検証成功 + autoSuspend 予定なし
 * - 'D_attention': credit_card かつ「期限切れ / 拒否 / 未検証 / autoSuspend 予定あり」のいずれか
 *
 * 2026-05-15: 'bank_transfer' を 'invoice' に統合 (UI ラベル「銀行振込」, 内部値 'invoice')。
 *   既存 DB の 'bank_transfer' レコードは credit_card 以外なので A_invoice 扱い (= 銀行振込) になる。
 */
export function deriveStripeState(info: StripePaymentInfo): 'A_invoice' | 'C_active' | 'D_attention' {
  if (info.paymentMethod !== 'credit_card') return 'A_invoice';
  // credit_card 払い
  const verified = info.cardVerificationStatus === 'valid';
  const autoSuspendPending = info.autoSuspendScheduledAt != null;
  if (verified && !autoSuspendPending) return 'C_active';
  return 'D_attention';
}

export function StripePaymentMethodSection({
  info,
  stripeEnabled,
  onRefresh,
}: StripePaymentMethodSectionProps): React.ReactElement {
  const { showSuccess, showError } = useToast();
  const [submitting, setSubmitting] = useState(false);
  const state = deriveStripeState(info);

  /**
   * 「💳 クレジットカード払いに切替」ボタン (状態 A) のハンドラ。
   * POST /api/tenants/me/billing/stripe/setup → Stripe Checkout へ window.location リダイレクト。
   */
  const handleSetup = async () => {
    const ok = window.confirm(
      'クレジットカード払いに切替えますか?\n\n' +
        '次の画面 (Stripe Checkout) でカード情報を入力してください。\n' +
        '検証成功時は自動でクレジットカード払いに切り替わります。\n' +
        '失敗 / キャンセル時は現在の銀行振込のままです。',
    );
    if (!ok) return;

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

  /**
   * 「🔧 Stripe ポータルで管理」ボタン (状態 C / D) のハンドラ。
   * POST /api/tenants/me/billing/stripe/portal → Customer Portal URL に新タブで遷移。
   */
  const handlePortal = async () => {
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
      // 新タブで開く (= ユーザが /settings/tenant に戻ってこられるように)
      window.open(json.data.portalUrl, '_blank', 'noopener,noreferrer');
    } catch {
      showError('通信エラーが発生しました');
    } finally {
      setSubmitting(false);
    }
  };

  /**
   * 「🏦 銀行振込に戻す」ボタン (状態 C のみ) のハンドラ。
   * PATCH /api/tenants/me/billing { paymentMethod: 'invoice' } で paymentMethod のみ反転。
   * Stripe Subscription は残したまま (= 再切替時に再利用)。
   *
   * 2026-05-15: 「請求書送付」表記から「銀行振込」表記に統一。
   *   内部値は 'invoice' のままで UI 表記のみ「銀行振込」(= 旧 'bank_transfer' との統合)。
   */
  const handleRevertToBankTransfer = async () => {
    const ok = window.confirm(
      '銀行振込に戻しますか?\n\n' +
        '当月以降の請求は super_admin が手動で請求書 PDF を作成し、請求担当者メール宛に送付します。\n' +
        '登録済のカード情報は Stripe 側に残り、Customer Portal で削除できます。',
    );
    if (!ok) return;

    setSubmitting(true);
    try {
      const res = await fetch('/api/tenants/me/billing', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paymentMethod: 'invoice' }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => null);
        showError(json?.error?.message ?? '支払い方法の変更に失敗しました');
        return;
      }
      showSuccess('銀行振込に戻しました');
      await onRefresh();
    } catch {
      showError('通信エラーが発生しました');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section
      className="space-y-3 rounded border bg-card p-4"
      aria-labelledby="stripe-payment-section-heading"
    >
      <h2 id="stripe-payment-section-heading" className="text-base font-semibold">
        支払い方法
      </h2>

      {state === 'A_invoice' && (
        <div className="space-y-3 text-sm">
          <p>現在の支払い方法: 🏦 銀行振込</p>
          <p className="text-muted-foreground">
            月末締めの翌月25日支払で、毎月請求書 PDF を請求担当者メールにお送りしています。
          </p>
          <Button
            type="button"
            onClick={handleSetup}
            disabled={!stripeEnabled || submitting}
            aria-label="クレジットカード払いに切替"
          >
            {submitting ? '処理中...' : '💳 クレジットカード払いに切替'}
          </Button>
          {!stripeEnabled && (
            <p className="text-xs text-muted-foreground">
              ※ クレジットカード払いは現在準備中です (運営による有効化待ち)。
            </p>
          )}
        </div>
      )}

      {state === 'C_active' && (
        <div className="space-y-3 text-sm">
          <p>現在の支払い方法: 💳 クレジットカード (自動引落)</p>
          <p className="text-muted-foreground">
            毎月末締めで Stripe が自動的に利用料を集計し、翌月初に登録カードから引き落とします。
            領収書 PDF は Stripe から自動メール送付されます。
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="secondary"
              onClick={handlePortal}
              disabled={submitting}
              aria-label="Stripe ポータルで管理"
            >
              {submitting ? '処理中...' : '🔧 Stripe ポータルで管理 (カード変更 / 履歴)'}
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={handleRevertToBankTransfer}
              disabled={submitting}
              aria-label="銀行振込に戻す"
            >
              🏦 銀行振込に戻す
            </Button>
          </div>
        </div>
      )}

      {state === 'D_attention' && (
        <div
          className="space-y-3 rounded border border-destructive/40 bg-destructive/10 p-3 text-sm"
          role="alert"
        >
          <p className="font-semibold text-destructive">
            ⚠️ 現在の支払い方法: クレジットカード (要対応)
          </p>
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
          <Button
            type="button"
            variant="default"
            onClick={handlePortal}
            disabled={submitting}
            aria-label="Stripe ポータルでカードを更新"
          >
            {submitting ? '処理中...' : '🔧 Stripe ポータルでカードを更新する'}
          </Button>
        </div>
      )}
    </section>
  );
}
