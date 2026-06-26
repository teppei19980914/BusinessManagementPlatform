'use client';

/**
 * テナント設定 (プラン変更 + 予算上限) のクライアント Component (PR-X4)
 *
 * UI 構成:
 *   1. 現在のプラン表示 + 当月使用量
 *   2. プラン変更フォーム (ラジオボタン)
 *   3. 月次予算上限フォーム (数値 / 無制限切替)
 *   4. 予約済プラン変更の表示 + キャンセル
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
// fix/jwt-resign-for-netlify (2026-05-18): useSession import を削除。
//   旧コードは update() で JWT 反映していたが、サーバ側で再署名する設計に変更したため不要。
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useToast } from '@/components/toast-provider';
import { SUPPORTED_LOCALES, SELECTABLE_LOCALES } from '@/config';
// ADR-0030 (2026-05-30): client-safe な定数なので直接 import (= embedding-pricing.ts は Prisma を import しない設計)。
import {
  BEGINNER_EMBEDDING_MONTHLY_LIMIT,
  EMBEDDING_PRICE_JPY_BY_PLAN,
} from '@/config/embedding-pricing';
// PR-4 (2026-05-15): テナント TZ で日付を表示
import { useFormatters } from '@/lib/use-formatters';
// 2026-05-14: 自テナント DB 容量 + API 利用量の再集計ボタン + drift 警告
import { RecalculateButton } from '@/components/recalculate-button';
import { UsageDriftBadge } from '@/components/usage-drift-badge';
import type { ApiUsageReconcileResult } from '@/services/api-usage-recalc.service';
// PR-V8.1 (2026-05-19) ★請求重要★: テナント管理者自身が drift を修復可能に
import { RepairOwnDriftButton } from './repair-own-drift-button';
// Q5(3) (2026-05-14): 縮退モード状態 (Server Component で取得した snapshot を受け取る)
import type { DegradedModeState } from '@/services/degraded-mode.service';
// PR-S5 (2026-05-14): Stripe 支払い方法セクション
import { StripePaymentMethodSection, type StripeCardSummaryProp } from './stripe-payment-method-section';
// feat/tenant-settings-tabs (2026-05-22): タブ識別子 + URL ヘルパ (純粋関数、testable)
import {
  buildStripeCleanedUrl,
  pickInitialTab,
  type TenantSettingsTab,
} from './tab-helpers';

type TenantSelfInfo = {
  id: string;
  /** feat/settings-tenant-identity (2026-05-21): Tenant.slug。ログイン入力の正規 ID。
   *  管理者が一般ユーザに伝える値であり、ヘッダーで独立ラベル表示する。 */
  slug: string;
  tenantSeq: number | null;
  name: string;
  /** feat/settings-tenant-identity (2026-05-21): テナント作成日時 (詳細欄表示用)。 */
  createdAt: Date | string;
  /** feat/settings-tenant-identity (2026-05-21): per-call 単価 (¥10 Haiku / ¥15 Sonnet、ADR-0019 改定後)。 */
  pricePerCallHaiku: number;
  pricePerCallSonnet: number;
  /** feat/settings-tenant-identity (2026-05-21): テナント停止状態 (PR #372)。 */
  suspendedAt: Date | string | null;
  suspendReason: string | null;
  plan: 'beginner' | 'expert' | 'pro';
  monthlyBudgetCapJpy: number | null;
  /** ADR-0030 (2026-05-30): Embedding 系専用の月次予算上限 (Expert/Pro 任意設定、Beginner は API 層で NULL 強制) */
  monthlyEmbeddingBudgetCapJpy: number | null;
  beginnerMaxSeats: number;
  beginnerMonthlyCallLimit: number;
  currentMonthApiCallCount: number;
  currentMonthApiCostJpy: number;
  /** ADR-0022 (2026-06-01): Embedding 系の当月呼出回数 (全プラン件数記録、Beginner も cost=0 で件数のみ) */
  currentMonthEmbeddingCallCount: number;
  /** ADR-0022 (2026-06-01) / ADR-0029 (¥1→¥5 改定): Embedding 系の当月課金額 (Beginner=0 / Expert=Pro=件数×¥5) */
  currentMonthEmbeddingCostJpy: number;
  /** ADR-0030 (2026-05-30): 当月 DB 容量超過想定額 (請求タブ「今月請求金額」セクション用) */
  estimatedDbCapacityOverageJpy: number;
  /** ADR-0030 (2026-05-30): 当月ファイルストレージ超過想定額 (請求タブ「今月請求金額」セクション用) */
  estimatedFileStorageOverageJpy: number;
  scheduledPlanChangeAt: Date | string | null;
  scheduledNextPlan: string | null;
  activeUserCount: number;
  // P-G (2026-05-08): 請求先情報 / PR C (2026-05-09 #5/#8/#10) で個人法人 + 構造化住所
  billingType: string;
  billingCompanyName: string | null;
  billingContactName: string | null;
  billingContactEmail: string | null;
  /** Legacy: 旧 単一 Text 住所 (フォールバック表示用) */
  billingAddress: string | null;
  billingPostalCode: string | null;
  billingPrefecture: string | null;
  billingCity: string | null;
  billingStreetAddress: string | null;
  billingBuildingName: string | null;
  billingPhoneNumber: string | null;
  paymentMethod: string;
  // P-B (2026-05-08): Beginner プラン期限ステータス
  beginnerExpiryState: 'active' | 'warning_60' | 'warning_75' | 'expired';
  beginnerDaysRemaining: number | null;
  // PR-1 (2026-05-15): テナント単位 TZ / locale (旧 User.timezone/locale の集約先)
  timezone: string;
  locale: string;
  // PR-S5 (2026-05-14): Stripe 連携情報 (Server Component から Date は string で渡る)
  stripeCustomerId: string | null;
  /** PR #425 (2026-05-21): UI 「クレジットカード情報更新」ボタンの動作分岐に使用 (null → setup、非 null → portal) */
  stripeSubscriptionId: string | null;
  stripeSubscriptionStatus: string | null;
  stripeDefaultPaymentMethodId: string | null;
  cardVerificationStatus: string | null;
  cardLastVerifiedAt: Date | string | null;
  autoSuspendScheduledAt: Date | string | null;
};

type PlanLabel = { value: 'beginner' | 'expert' | 'pro'; label: string; descriptionKey: 'planBeginnerDescription' | 'planExpertDescription' | 'planProDescription' };

// ADR-0019 (2026-05-24): 課金対象を BILLABLE_FEATURE_UNITS (project-upsert /
// suggestion-explanation) のみに限定し、資産入力・チャット検索・自動インポートを全プラン無料化。
// Beginner 上限 100→50 (課金対象 call のみカウント)、Expert ¥5→¥10 / Pro ¥15 据置。
// ADR-0025 (2026-05-29): Beginner プランは DB 50MB / Storage 100MB 無料枠超過で新規作成/更新を
//   write ブロック (削除のみ可)。overage 課金は発生せず、削除後は自動再集計で再書込み可能。
const PLAN_OPTIONS: PlanLabel[] = [
  {
    value: 'beginner',
    label: 'Beginner',
    descriptionKey: 'planBeginnerDescription',
  },
  {
    value: 'expert',
    label: 'Expert',
    descriptionKey: 'planExpertDescription',
  },
  {
    value: 'pro',
    label: 'Pro',
    descriptionKey: 'planProDescription',
  },
];

// fix/list-export-import-bugs (2026-05-26): StorageInitialInfo 型と storageInitialInfo prop は
//   ADR-0020 / ADR-0021 で従量課金化されたため削除。ストレージ使用量は DbCapacitySection /
//   FileStorageSection (server component) が独立に表示する。

export function TenantSettingsClient({
  initialInfo,
  apiReconcile,
  degradedMode,
  stripeEnabled,
  cardSummary,
  dbCapacitySection,
  fileStorageSection,
}: {
  initialInfo: TenantSelfInfo;
  /** 2026-05-14: 自テナントの API 利用量整合性チェック結果 (drift 警告用) */
  apiReconcile: ApiUsageReconcileResult | null;
  /** Q5(3) (2026-05-14): 縮退モード状態 + embedding 未生成件数 (取得失敗時は null) */
  degradedMode: DegradedModeState | null;
  /** PR-S5 (2026-05-14): Stripe feature flag (= STRIPE_ENABLED env var) */
  stripeEnabled: boolean;
  /**
   * PR #425 (2026-05-22): Stripe 登録カード情報サマリ (brand/last4/exp)。
   * カード未登録 / Stripe API 失敗 / Stripe disabled なら null。
   */
  cardSummary: StripeCardSummaryProp | null;
  /** fix/list-export-import-bugs (2026-05-26): server component で render 済の
   *  DB 容量 / ファイルストレージ セクション (使用量タブ内に配置)。 */
  dbCapacitySection: React.ReactNode;
  fileStorageSection: React.ReactNode;
}) {
  // PR-4 (2026-05-15): テナント TZ で日付を表示するため useFormatters を導入
  const { formatDate } = useFormatters();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { showSuccess, showError, showSuccessKey, showErrorKey } = useToast();
  const t = useTranslations('tenantSettings');
  const [info, setInfo] = useState(initialInfo);
  const [selectedPlan, setSelectedPlan] = useState(initialInfo.plan);
  const [submitting, setSubmitting] = useState(false);
  // ADR-0030 (2026-05-30): 月次予算上限フォームは概要タブから「使用量タブ内の生成AI系セクション直下」に
  //   移動。LLM 用 + Embedding 用の 2 つを独立フォーム化し、プラン変更フォームから state を分離。

  // feat/tenant-settings-tabs (2026-05-22): 3 タブ (概要/使用量/請求) 構成。
  //   URL クエリ ?tab= で active tab を持続させ、ブックマーク / Stripe Checkout 戻り後の
  //   タブ復元を可能にする。不正値は overview にフォールバック。
  const initialTabFromUrl = pickInitialTab(searchParams.get('tab'));
  const [activeTab, setActiveTab] = useState<TenantSettingsTab>(initialTabFromUrl);

  // BillingContactSection の入力中フラグ (タブ切替時の取りこぼし防止)。
  //   state ではなく ref で持つ理由: ガード判定で参照するだけで再 render 不要。
  const billingFormDirtyRef = useRef(false);

  const handleTabChange = useCallback(
    (value: string) => {
      const next = pickInitialTab(value);
      if (billingFormDirtyRef.current && next !== activeTab) {
        const ok = confirm(t('confirmTabChangeDirty'));
        if (!ok) return;
        // タブを離れたら dirty 扱いを解除 (再入力で再度立つ)
        billingFormDirtyRef.current = false;
      }
      setActiveTab(next);
      const params = new URLSearchParams(searchParams.toString());
      if (next === 'overview') params.delete('tab');
      else params.set('tab', next);
      const queryString = params.toString();
      router.replace(queryString ? `/settings/tenant?${queryString}` : '/settings/tenant');
    },
    [activeTab, router, searchParams],
  );

  // PR-S5 (2026-05-14): Stripe Checkout / setup/complete から戻った時の URL query を捕捉し、
  //   トーストで結果を通知 + URL から stripe_setup / reason だけ除去 (tab クエリは保持)。
  //   feat/tenant-settings-tabs (2026-05-22): tab を残すため URL クリーニングを部分削除に変更。
  useEffect(() => {
    const status = searchParams.get('stripe_setup');
    if (status == null) return;
    if (status === 'success') {
      // PR #425 (2026-05-21): paymentMethod 切替は別操作 (請求先情報フォーム) に分離されたため、
      //   本処理は「カード情報の登録/更新成功」の通知に文言を統一。
      showSuccessKey('tenantSettings.toastStripeCardRegistered');
    } else if (status === 'pending') {
      // feat/credit-card-ui-guard (2026-05-30) / KDD §5.X+185:
      //   Stripe Checkout 完了戻り時に session が失効していた場合 (= login 経由で再ログイン後にここに着く)。
      //   カード登録自体は Stripe Checkout で完了しており、Webhook (payment_method.attached /
      //   customer.subscription.created) 経由で DB 同期されるため、ユーザには「同期中」を案内。
      const reason = searchParams.get('reason') ?? '';
      const reasonLabel =
        reason === 'session_expired'
          ? t('toastStripeCardPendingReasonSessionExpired')
          : t('toastStripeCardPendingReasonDefault');
      showSuccess(t('toastStripeCardPending', { reason: reasonLabel }));
    } else if (status === 'canceled') {
      showErrorKey('tenantSettings.toastStripeCardCanceled');
    } else if (status === 'failed') {
      const reason = searchParams.get('reason') ?? '';
      const reasonKeyMap: Record<string, string> = {
        card_declined: 'toastStripeCardFailedReasonCardDeclined',
        expired_card: 'toastStripeCardFailedReasonExpiredCard',
        processing_error: 'toastStripeCardFailedReasonProcessingError',
        verification_required: 'toastStripeCardFailedReasonVerificationRequired',
        // feat/credit-card-ui-guard (2026-05-30): complete route の追加 reason
        not_admin: 'toastStripeCardFailedReasonNotAdmin',
        session_id_missing: 'toastStripeCardFailedReasonSessionIdMissing',
      };
      const reasonKey = reasonKeyMap[reason] ?? 'toastStripeCardFailedReasonUnknown';
      const reasonMessage = t(reasonKey as Parameters<typeof t>[0]);
      showError(t('toastStripeCardFailed', { reason: reasonMessage }));
    }
    router.replace(buildStripeCleanedUrl(searchParams));
    // showSuccess/showError は安定参照、router は安定。初回マウント時のみ実行されればよい。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const planChanged = selectedPlan !== info.plan;
  const isDowngrade =
    info.plan === 'pro' ? selectedPlan !== 'pro' : info.plan === 'expert' && selectedPlan === 'beginner';
  const beginnerSeatsExceeded = selectedPlan === 'beginner' && info.activeUserCount > info.beginnerMaxSeats;

  const refreshInfo = async () => {
    const res = await fetch('/api/tenants/me');
    if (!res.ok) return;
    const json = await res.json();
    setInfo(json.data);
    setSelectedPlan(json.data.plan);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (beginnerSeatsExceeded) {
      showErrorKey('tenantSettings.toastBeginnerSeatsError');
      return;
    }
    if (isDowngrade) {
      // 2026-05-14: Expert↔Pro ダウングレードは即時反映 (旧仕様の翌月予約から変更)。
      //   Pro 限定機能 (「なぜ?」AI 説明等) が即座に使えなくなるため、明示確認は維持。
      //   Beginner ダウングレードは API 側で BEGINNER_DOWNGRADE_FORBIDDEN なので
      //   ここでは Expert↔Pro 想定の文言に統一。
      const ok = confirm(t('confirmDowngrade'));
      if (!ok) return;
    }

    setSubmitting(true);
    try {
      const body: Record<string, unknown> = {};
      if (planChanged) body.plan = selectedPlan;
      // ADR-0030 (2026-05-30): 月次予算上限フォーム (LLM cap / Embedding cap) は UsageSection 内の
      //   独立フォーム (BudgetCapForm) に移動したため、本フォームでは扱わない。プラン変更のみ送信。

      if (Object.keys(body).length === 0) {
        showErrorKey('tenantSettings.toastNoChanges');
        setSubmitting(false);
        return;
      }

      const res = await fetch('/api/tenants/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => null);
        showError(json?.error?.message ?? t('toastUpdateFailed'));
        return;
      }
      const json = await res.json();
      if (json.data.appliedImmediately) {
        showSuccessKey('tenantSettings.toastAppliedImmediately');
      } else {
        // 2026-05-14: LLM プラン変更は全て即時反映に統一されたため、本ブランチは
        //   実運用では到達しない (API は appliedImmediately=true のみ返す)。
        //   万一サーバ側の挙動が変わった場合の defensive 表示として残置。
        //   PR-4 (2026-05-15): テナント TZ で日付表示。
        const date = formatDate(json.data.scheduledFor);
        showSuccess(t('toastScheduledFor', { date }));
      }
      await refreshInfo();
      router.refresh();
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancelScheduled = async () => {
    if (!confirm(t('confirmCancelScheduled'))) return;
    setSubmitting(true);
    try {
      const res = await fetch('/api/tenants/me', { method: 'DELETE' });
      if (!res.ok) {
        showErrorKey('tenantSettings.toastCancelScheduledFailed');
        return;
      }
      showSuccessKey('tenantSettings.toastCancelScheduledSuccess');
      await refreshInfo();
      router.refresh();
    } finally {
      setSubmitting(false);
    }
  };

  const budgetUsagePercent =
    info.monthlyBudgetCapJpy && info.monthlyBudgetCapJpy > 0
      ? Math.min(100, Math.round((info.currentMonthApiCostJpy / info.monthlyBudgetCapJpy) * 100))
      : null;
  // ADR-0030 (2026-05-30): Embedding 用予算消化率 (LLM 用と同パターン)
  const embeddingBudgetUsagePercent =
    info.monthlyEmbeddingBudgetCapJpy && info.monthlyEmbeddingBudgetCapJpy > 0
      ? Math.min(
          100,
          Math.round((info.currentMonthEmbeddingCostJpy / info.monthlyEmbeddingBudgetCapJpy) * 100),
        )
      : null;

  return (
    <div className="space-y-6">
      {/* ============================================================
          feat/tenant-settings-tabs (2026-05-22): 共通ヘッダー (タブ外)
          テナント識別 / 再集計ボタン / 状態系バナーはどのタブからでも
          見える必要があるため Tabs の外に配置。
          ============================================================ */}
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          {/* feat/collapsed-nav-screen-title (2026-06-05): 画面名「テナント設定」の見出しは撤去。
              ナビ折りたたみ幅でのみ CollapsedNavScreenTitle (layout) が表示する (他画面と統一)。
              テナント名 / 組織 ID の識別情報はここに残す。 */}
          <p className="text-sm text-muted-foreground">
            {t('headerTenantName', { name: info.name })}
            {info.tenantSeq != null && <span className="ml-2">{t('headerTenantSeq', { seq: info.tenantSeq })}</span>}
          </p>
          {/* feat/settings-tenant-identity (2026-05-21): 組織 ID (slug) を独立ラベルで明示。
              ユーザのログイン入力に対応する値であり、管理者が招待時にユーザに伝える正規の識別子。 */}
          <p className="text-sm text-muted-foreground">
            {t('headerOrgId')}{' '}
            <span className="font-mono" data-testid="tenant-settings-slug">
              {info.slug}
            </span>
          </p>
        </div>
        {/* 2026-05-14: 自テナント全体の再集計ボタン (画面遷移時は自動再集計済だが手動更新可) */}
        <RecalculateButton
          endpoint="/api/tenants/me/recalculate"
          label={t('headerRecalcLabel')}
          size="default"
        />
      </div>
      <p className="text-xs text-muted-foreground">
        {t('headerRecalcHint')}
      </p>

      {/* feat/settings-tenant-identity (2026-05-21): テナント停止中バナー (PR #372 = 支払滞納等で read-only)。 */}
      {info.suspendedAt && <SuspendedBanner info={info} />}

      {/* P-B (2026-05-08): Beginner プラン期限バナー (= ユーザ確定方針で全タブ常時表示) */}
      <BeginnerExpiryBanner info={info} />

      {/* ============================================================
          feat/tenant-settings-tabs (2026-05-22): 3 タブ構成
          - overview: プラン / 設定 / データ管理 / 解約
          - usage   : 当月使用量 / ストレージ / 縮退モード警告
          - billing : 請求先 / 支払い方法 / 請求履歴リンク
          ============================================================ */}
      <Tabs value={activeTab} onValueChange={handleTabChange}>
        <TabsList className="h-auto flex-wrap [&>*]:flex-none" data-testid="tenant-settings-tabs">
          <TabsTrigger value="overview" data-testid="tab-overview">
            {t('tabOverview')}
          </TabsTrigger>
          <TabsTrigger value="usage" data-testid="tab-usage">
            {t('tabUsage')}
          </TabsTrigger>
          <TabsTrigger value="billing" data-testid="tab-billing">
            {t('tabBilling')}
          </TabsTrigger>
        </TabsList>

        {/* --- 概要タブ --- */}
        <TabsContent value="overview" className="mt-4 space-y-6">
          {/* 予約済プラン変更 (PR-4: テナント TZ で日付表示) */}
          {info.scheduledPlanChangeAt && info.scheduledNextPlan && (
            <section className="rounded border border-amber-300 bg-amber-50 p-4 text-sm dark:bg-amber-900/30">
              <p>
                <strong>{t('scheduledPlanChange')}</strong>{' '}
                {formatDate(
                  typeof info.scheduledPlanChangeAt === 'string'
                    ? info.scheduledPlanChangeAt
                    : info.scheduledPlanChangeAt.toISOString(),
                )}
                {t('scheduledPlanChangeTo', { plan: info.scheduledNextPlan ?? '' })}
              </p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="mt-2"
                onClick={handleCancelScheduled}
                disabled={submitting}
              >
                {t('scheduledPlanCancelButton')}
              </Button>
            </section>
          )}

          {/* プラン変更 + 予算上限 */}
          <form onSubmit={handleSubmit} className="space-y-4">
            <section className="rounded border p-4">
              <h2 className="mb-2 font-semibold">{t('planSectionTitle')}</h2>
              <p className="mb-3 text-xs text-muted-foreground">
                {t('planSectionHint')}
              </p>
              <div className="space-y-2">
                {PLAN_OPTIONS
                  // PR #425 (2026-05-22) ★UX 改善★: Expert/Pro 契約中は Beginner ラジオを完全非表示。
                  //   旧 UI は Beginner ラジオを表示 → 選択可能 → 「変更を保存」確認ダイアログまで進める → API で
                  //   BEGINNER_DOWNGRADE_FORBIDDEN 拒否、というユーザを混乱させる挙動だった。
                  //   サーバ側ガード (tenant-self.service.ts BEGINNER_DOWNGRADE_FORBIDDEN) は維持する
                  //   (= UI バイパスの defense-in-depth)。
                  .filter((p) => {
                    if ((info.plan === 'expert' || info.plan === 'pro') && p.value === 'beginner') {
                      return false;
                    }
                    return true;
                  })
                  .map((p) => (
                  <label
                    key={p.value}
                    className="flex cursor-pointer items-start gap-2 rounded border p-3 hover:bg-muted/30"
                  >
                    <input
                      type="radio"
                      name="plan"
                      value={p.value}
                      checked={selectedPlan === p.value}
                      onChange={() => setSelectedPlan(p.value)}
                      className="mt-1"
                    />
                    <div>
                      <p className="font-medium">{p.label}</p>
                      <p className="text-xs text-muted-foreground">{t(p.descriptionKey)}</p>
                      {info.plan === p.value && (
                        <p className="mt-1 text-xs text-info">{t('planCurrentBadge')}</p>
                      )}
                    </div>
                  </label>
                ))}
              </div>
              {beginnerSeatsExceeded && (
                <p className="mt-2 text-sm text-destructive">
                  {t('planBeginnerSeatsExceeded', { maxSeats: info.beginnerMaxSeats, activeCount: info.activeUserCount })}
                </p>
              )}
            </section>

            {/* ADR-0030 (2026-05-30): 月次予算上限フォーム (LLM 用 / Embedding 用) は使用量タブ内の
                各セクション (当月 LLM 実行回数 / Embedding 生成回数) 直下に移動した。
                プラン変更フォームから分離して独立 form 化することで、設定対象と表示の co-location を
                実現 (= 使用量を見ながら上限調整できる UX)。実装は UsageSection 内 BudgetCapForm 参照。 */}

            <Button type="submit" disabled={submitting || beginnerSeatsExceeded}>
              {submitting ? t('submitSaving') : t('submitSave')}
            </Button>
          </form>

          {/* PR-1 (2026-05-15): テナント単位の言語・タイムゾーン設定 */}
          <TenantI18nSection
            initialTimezone={info.timezone}
            initialLocale={info.locale}
            onUpdate={async () => {
              await refreshInfo();
            }}
          />

          {/* P-C (2026-05-08): データエクスポート */}
          <DataExportSection />

          {/* P-D (2026-05-08): データインポート */}
          <DataImportSection />

          {/* feat/starter-data-import (2026-06-05): スターターデータ一括取込/削除 */}
          <SampleDataSection
            plan={info.plan}
            onUpdate={async () => {
              await refreshInfo();
            }}
          />

          {/* feat/settings-tenant-identity (2026-05-21): 詳細識別情報 (折りたたみ)。 */}
          <TenantIdentityDetailsSection info={info} />

          {/* テナント解約 (2026-05-08): 危険な操作なので末尾配置 + 名称一致確認 */}
          <SelfDeleteTenantSection tenantName={info.name} />
        </TabsContent>

        {/* --- 使用量タブ --- */}
        <TabsContent value="usage" className="mt-4 space-y-6">
          {/* Q5(3) (2026-05-14): 縮退モード起動中バナー + embedding 未生成件数 */}
          {degradedMode && <DegradedModeSection state={degradedMode} />}

          {/* ADR-0030 (2026-05-30): 2 大セクション構造化。「生成AI系利用量」(= LLM + Embedding) と
              「DB系利用量」(= DB 容量 + ファイルストレージ) を視覚的に分離し、課金軸の理解を助ける。
              月次予算上限フォームは LLM 系 / Embedding 系のそれぞれに co-located (= 概要タブから移動)。 */}
          <div className="space-y-4" data-testid="generative-ai-usage-group">
            <h2 className="text-lg font-bold border-b pb-1">{t('generativeAiUsageTitle')}</h2>
            <UsageSection
              info={info}
              budgetUsagePercent={budgetUsagePercent}
              embeddingBudgetUsagePercent={embeddingBudgetUsagePercent}
              apiReconcile={apiReconcile}
              onUpdate={refreshInfo}
            />
          </div>

          <div className="space-y-4" data-testid="db-usage-group">
            <h2 className="text-lg font-bold border-b pb-1">{t('dbUsageTitle')}</h2>
            {/* fix/list-export-import-bugs (2026-05-26): DB 容量 / ファイルストレージ セクションを
                使用量タブ内に集約。旧 page.tsx ではタブの上にあったが、UX 改善のため使用量タブに移動。
                いずれも async server component の出力を ReactNode prop で受領。
                ADR-0030 (2026-05-30): DB系には予算上限を設けない (= 「データはたすきばの命」)。要望出たら別 ADR で検討。 */}
            {/* ADR-0020 (2026-05-25): DB 容量従量課金 */}
            {dbCapacitySection}
            {/* ADR-0021 (2026-05-26): ファイルストレージ従量課金 */}
            {fileStorageSection}
          </div>
        </TabsContent>

        {/* --- 請求タブ --- */}
        <TabsContent value="billing" className="mt-4 space-y-6">
          {/* ADR-0030 (2026-05-30): 「今月請求金額」セクション。
              billing invariant (feedback_billing_invariant): LLM + Embedding + DB 超過 + Storage 超過
              = 表示合計 = 月末請求書根拠 = ApiCallLog SUM。月末 cron で確定、DB / Storage は月中 peak ベースの想定。 */}
          <MonthlyBillingTotalSection info={info} />

          {/* P-G (2026-05-08): 請求先情報の編集
              PR #425 (2026-05-22) ★severity-1★: paymentMethod 変更後に Client state (info) を
              即座に再取得しないと、StripePaymentMethodSection の活性条件 (info.paymentMethod) が
              古いままで「クレジットカード情報更新」ボタンが非活性となり、credit_card 払いにも
              関わらずカード登録できない = 請求漏れ発生。refreshInfo を必ず渡す。
              feat/tenant-settings-tabs (2026-05-22): タブ切替時の取りこぼし防止に onDirtyChange も渡す。 */}
          <BillingContactSection
            initialInfo={info}
            stripeEnabled={stripeEnabled}
            onUpdate={refreshInfo}
            onDirtyChange={(dirty) => {
              billingFormDirtyRef.current = dirty;
            }}
          />

          {/* PR-S5 (2026-05-14): Stripe 支払い方法 (請求書 ↔ クレジットカード切替)
              PR #425 (2026-05-22): cardSummary を渡して登録カード情報を可視化 */}
          <StripePaymentMethodSection
            info={info}
            stripeEnabled={stripeEnabled}
            onRefresh={refreshInfo}
            cardSummary={cardSummary}
          />

          {/* feat/tenant-settings-tabs (2026-05-22): 請求履歴ページへの動線。
              現状 stripe-payment-method-section 内にもリンクがあるが、銀行振込ユーザでも
              履歴は参照する必要があるため請求タブ末尾に独立セクションとして配置。 */}
          <section className="rounded border p-4 text-sm">
            <h2 className="mb-2 text-lg font-semibold">{t('billingHistoryTitle')}</h2>
            <p className="mb-3 text-xs text-muted-foreground">
              {t('billingHistoryDescription')}
            </p>
            <Link
              href="/settings/tenant/billing"
              className="inline-flex items-center justify-center rounded-md border bg-background px-3 py-1.5 text-sm font-medium shadow-xs hover:bg-muted/30"
            >
              {t('billingHistoryLink')}
            </Link>
          </section>
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ================================================================
// feat/settings-tenant-identity (2026-05-21)
// ================================================================

/**
 * テナント停止中バナー (PR #372)。
 *
 * 停止理由を即座に把握できるよう、停止理由コードを業務文言に翻訳して表示する。
 * 解除フローは super_admin 操作 (POST /api/admin/super/tenants/:id/resume) のため、
 * 本画面 (テナント管理者向け) は read-only 表示のみ。
 */
function SuspendedBanner({ info }: { info: TenantSelfInfo }) {
  const t = useTranslations('tenantSettings');
  const reasonText =
    info.suspendReason === 'payment_delinquent'
      ? t('suspendReasonPaymentDelinquent')
      : info.suspendReason === 'tos_violation'
        ? t('suspendReasonTosViolation')
        : t('suspendReasonDefault');
  return (
    <section
      data-testid="tenant-suspended-banner"
      className="rounded border border-destructive/40 bg-destructive/10 p-4 text-sm"
    >
      <p className="font-semibold text-destructive">{t('suspendedBannerTitle')}</p>
      <p className="mt-1">{reasonText}</p>
      <p className="mt-2 text-xs text-muted-foreground">
        {t('suspendedBannerBody')}
      </p>
    </section>
  );
}

/**
 * テナント詳細識別情報 (折りたたみ)。
 *
 * 一般運用では参照する必要が薄いが、サポート問い合わせや内部デバッグで有用な情報を
 * 1 箇所にまとめる。UUID / プラン単価 / 作成日時 / カード検証 / 自動停止予定。
 */
function TenantIdentityDetailsSection({ info }: { info: TenantSelfInfo }) {
  const t = useTranslations('tenantSettings');
  const cardLastVerifiedAt =
    info.cardLastVerifiedAt == null
      ? null
      : typeof info.cardLastVerifiedAt === 'string'
        ? info.cardLastVerifiedAt
        : info.cardLastVerifiedAt.toISOString();
  const autoSuspendScheduledAt =
    info.autoSuspendScheduledAt == null
      ? null
      : typeof info.autoSuspendScheduledAt === 'string'
        ? info.autoSuspendScheduledAt
        : info.autoSuspendScheduledAt.toISOString();
  const createdAt =
    typeof info.createdAt === 'string' ? info.createdAt : info.createdAt.toISOString();
  return (
    <details
      data-testid="tenant-identity-details"
      className="rounded border p-4 text-sm"
    >
      <summary className="cursor-pointer font-semibold">{t('identityDetailsSummary')}</summary>
      <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-[max-content_1fr]">
        <dt className="text-muted-foreground">{t('identityTenantUuid')}</dt>
        <dd className="font-mono text-xs">{info.id}</dd>
        <dt className="text-muted-foreground">{t('identityTenantCreatedAt')}</dt>
        <dd>{formatDateTime(createdAt)}</dd>
        <dt className="text-muted-foreground">{t('identityPriceHaiku')}</dt>
        <dd>{t('identityPriceHaikuValue', { price: info.pricePerCallHaiku })}</dd>
        <dt className="text-muted-foreground">{t('identityPriceSonnet')}</dt>
        <dd>{t('identityPriceSonnetValue', { price: info.pricePerCallSonnet })}</dd>
        {cardLastVerifiedAt && (
          <>
            <dt className="text-muted-foreground">{t('identityCardLastVerifiedAt')}</dt>
            <dd>{formatDateTime(cardLastVerifiedAt)}</dd>
          </>
        )}
        {autoSuspendScheduledAt && (
          <>
            <dt className="text-muted-foreground">{t('identityAutoSuspendAt')}</dt>
            <dd className="text-destructive">{formatDateTime(autoSuspendScheduledAt)}</dd>
          </>
        )}
      </dl>
    </details>
  );
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  // テナント TZ は parent component の useFormatters で取れるが、ここではサポート用の
  // 詳細欄なので JST 固定で簡潔に表示する (タイムゾーンを文字列で明示)。
  return d.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }) + ' JST';
}

// ================================================================
// PR-2 (2026-05-15): 当月使用量セクション (plan 別タイル構成)
// ================================================================

/**
 * 当月使用量セクション。プラン別にタイル構成を切り替える。
 *
 * - Beginner: 「API 呼出」+ 「月次API呼出 残数」 (¥0 固定なので費用タイル/予算タイルは非表示)
 * - Expert / Pro: 「API 呼出」+「API 費用」+「月次予算上限」 (従来通り)
 *
 * 設計判断: Beginner では費用が常に 0 円のため「API 費用」タイルを出す意味がない。
 * 代わりに「残数」を見せる方が利用者にとっての操作の指針 (= あと何回呼べるか) として有用。
 */
/**
 * Q5(3) (2026-05-14): 縮退モード状態 + embedding 未生成件数の表示セクション。
 *
 * - state.active=true: 「縮退モード起動中」赤バナー + 原因を表示
 * - state.active=false かつ nullEmbeddings.total > 0: 黄色 info で未生成件数を表示
 *   (= 月初バッチで補完予定の件数を可視化)
 * - state.active=false かつ nullEmbeddings.total === 0: 何も表示しない (UI ノイズ回避)
 */
function DegradedModeSection({ state }: { state: DegradedModeState }) {
  const t = useTranslations('tenantSettings');
  const { nullEmbeddings } = state;

  if (!state.active && nullEmbeddings.total === 0) return null;

  if (state.active) {
    // ADR-0019 (2026-05-24): Beginner LLM 上限は課金対象 call (プロジェクト作成/更新) のみカウント。
    //   ADR-0030 (2026-05-30): Embedding 系 2 reason を追加。Embedding ブロック中も既存 embedding での
    //   チャット意味検索は継続、新規 embedding 生成のみ停止、失敗分は月初 backfill cron で次月補填。
    const isEmbeddingReason =
      state.reason === 'embedding_budget_exceeded' ||
      state.reason === 'embedding_beginner_limit_exceeded';
    const reasonText = (() => {
      switch (state.reason) {
        case 'beginner_limit_exceeded':
          return t('degradedModeReasonBeginnerLimit', { limit: state.beginnerMonthlyCallLimit ?? '?' });
        case 'budget_exceeded':
          return t('degradedModeReasonBudgetExceeded', { cap: state.monthlyBudgetCapJpy?.toLocaleString() ?? '?' });
        case 'embedding_beginner_limit_exceeded':
          return t('degradedModeReasonEmbeddingBeginnerLimit', { limit: state.beginnerEmbeddingMonthlyLimit ?? '?' });
        case 'embedding_budget_exceeded':
          return t('degradedModeReasonEmbeddingBudgetExceeded', { cap: state.monthlyEmbeddingBudgetCapJpy?.toLocaleString() ?? '?' });
        default:
          return t('degradedModeReasonDefault');
      }
    })();

    return (
      <section className="rounded border border-destructive/40 bg-destructive/10 p-4 text-sm">
        <p className="font-semibold text-destructive">{t('degradedModeTitle')}</p>
        <p className="mt-1">{reasonText}</p>
        <ul className="mt-2 list-disc space-y-0.5 pl-5 text-muted-foreground">
          {isEmbeddingReason ? (
            <>
              <li>{t('degradedModeEmbeddingStopDetail')}</li>
              <li>{t('degradedModeEmbeddingBackfillDetail')}</li>
              <li>
                {state.reason === 'embedding_budget_exceeded' && t('degradedModeEmbeddingBudgetRecoverHint')}
                {state.reason === 'embedding_beginner_limit_exceeded' && t('degradedModeEmbeddingBeginnerRecoverHint')}
              </li>
              <li>{t('degradedModeEmbeddingLlmIndependent')}</li>
            </>
          ) : (
            <>
              <li>{t('degradedModeLlmStopDetail')}</li>
              <li>{t('degradedModeLlmSuggestionDetail')}</li>
              <li>
                {t('degradedModeLlmNullEmbeddingsDetail', {
                  total: nullEmbeddings.total,
                  projects: nullEmbeddings.projects,
                  knowledges: nullEmbeddings.knowledges,
                  risksIssues: nullEmbeddings.risksIssues,
                  retrospectives: nullEmbeddings.retrospectives,
                })}
              </li>
              <li>
                {t('degradedModeLlmBackfillDetail')}
                {state.reason === 'budget_exceeded' && t('degradedModeLlmBudgetRecoverHint')}
                {state.reason === 'beginner_limit_exceeded' && t('degradedModeLlmBeginnerRecoverHint')}
              </li>
            </>
          )}
        </ul>
      </section>
    );
  }

  // 縮退中ではないが、過去の縮退で残った未生成件数がある場合
  return (
    <section className="rounded border border-amber-300 bg-amber-50 p-4 text-sm dark:bg-amber-900/30">
      <p className="font-semibold">
        {t('degradedModeNullEmbeddingsTitle', { total: nullEmbeddings.total })}
      </p>
      <p className="mt-1 text-muted-foreground">
        {t('degradedModeNullEmbeddingsDetail', {
          projects: nullEmbeddings.projects,
          knowledges: nullEmbeddings.knowledges,
          risksIssues: nullEmbeddings.risksIssues,
          retrospectives: nullEmbeddings.retrospectives,
        })}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        {t('degradedModeNullEmbeddingsHint')}
      </p>
    </section>
  );
}

function UsageSection({
  info,
  budgetUsagePercent,
  embeddingBudgetUsagePercent,
  apiReconcile,
  onUpdate,
}: {
  info: TenantSelfInfo;
  budgetUsagePercent: number | null;
  /** ADR-0030 (2026-05-30): Embedding 用予算消化率 */
  embeddingBudgetUsagePercent: number | null;
  /** 2026-05-14: ApiCallLog SUM との drift 結果。整合性検証用 */
  apiReconcile: ApiUsageReconcileResult | null;
  /** ADR-0030 (2026-05-30): BudgetCapForm から更新したときの再取得コールバック */
  onUpdate: () => Promise<void>;
}) {
  const t = useTranslations('tenantSettings');
  const isBeginner = info.plan === 'beginner';
  // ★ PR-V8.1 (2026-05-19) 請求 invariant: ApiCallLog SUM (真値) を優先表示。
  //   counter (info.currentMonthApiCallCount) は内部 cache。drift 時は壊れた値になり、
  //   テナント管理者画面とシステム管理者画面の表示一致が壊れる + 請求書根拠とも乖離する。
  //   apiReconcile が null (= 集計失敗) のときのみ counter にフォールバック。
  const displayCallCount =
    apiReconcile?.reconciledCallCount ?? info.currentMonthApiCallCount;
  const displayCostJpy =
    apiReconcile?.reconciledCostJpy ?? info.currentMonthApiCostJpy;
  // Beginner プラン残数も真値ベースで計算 (= 上限 - SUM)。負数にしないため Math.max(0, ...) で clamp。
  const beginnerCallsRemaining = Math.max(
    0,
    info.beginnerMonthlyCallLimit - displayCallCount,
  );
  // ADR-0030 (2026-05-30): Beginner Embedding 100 件試用上限の残数 (= 上限 - 現在の Embedding 呼出件数)
  const beginnerEmbeddingCallsRemaining = Math.max(
    0,
    BEGINNER_EMBEDDING_MONTHLY_LIMIT - info.currentMonthEmbeddingCallCount,
  );

  return (
    <>
      {/* ============================================================
          当月 LLM 実行回数 セクション (旧「当月使用量」、ADR-0030 でリネーム)
          ============================================================ */}
      <section
        className="rounded border p-4"
        title={t('usageLlmSectionTooltip')}
        data-testid="usage-llm-section"
      >
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-semibold">
            {t('usageLlmSectionTitle')}
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              {t('usageLlmSectionSubtitle')}
            </span>
            <UsageDriftBadge reconcile={apiReconcile} />
          </h2>
          <div className="flex items-center gap-2">
            <RecalculateButton
              endpoint="/api/tenants/me/recalculate"
              label={t('usageLlmRecalcLabel')}
            />
            {/* PR-V8.1: drift 検知時のみ修復ボタンを表示 */}
            {apiReconcile?.hasDrift && <RepairOwnDriftButton />}
          </div>
        </div>
        <div
          className={
            isBeginner
              ? 'grid grid-cols-1 gap-3 sm:grid-cols-2'
              : 'grid grid-cols-1 gap-3 sm:grid-cols-3'
          }
        >
          <div
            className="cursor-help"
            title={t('usageLlmCallCountTooltip')}
          >
            <p className="text-xs text-muted-foreground">{t('usageLlmCallCountLabel')}</p>
            <p className="text-xl font-bold">
              {displayCallCount.toLocaleString()}
              {isBeginner && (
                <span className="ml-1 text-sm font-normal text-muted-foreground">
                  / {info.beginnerMonthlyCallLimit}
                </span>
              )}
            </p>
          </div>

          {isBeginner ? (
            <div
              className="cursor-help"
              title={t('usageLlmRemainingTooltip')}
            >
              <p className="text-xs text-muted-foreground">{t('usageLlmRemainingLabel')}</p>
              <p
                className={`text-xl font-bold ${
                  beginnerCallsRemaining === 0
                    ? 'text-destructive'
                    : beginnerCallsRemaining <= 10
                      ? 'text-amber-600'
                      : ''
                }`}
              >
                {beginnerCallsRemaining.toLocaleString()}
                <span className="ml-1 text-sm font-normal text-muted-foreground">{t('usageLlmRemainingUnit')}</span>
              </p>
            </div>
          ) : (
            <>
              <div
                className="cursor-help"
                title={t('usageLlmCostTooltip')}
              >
                <p className="text-xs text-muted-foreground">{t('usageLlmCostLabel')}</p>
                <p className="text-xl font-bold">
                  ¥{displayCostJpy.toLocaleString()}
                </p>
              </div>
              <div
                className="cursor-help"
                title={t('usageLlmBudgetCapTooltip')}
              >
                <p className="text-xs text-muted-foreground">{t('usageLlmBudgetCapLabel')}</p>
                <p className="text-xl font-bold">
                  {info.monthlyBudgetCapJpy != null
                    ? `¥${info.monthlyBudgetCapJpy.toLocaleString()}`
                    : t('usageLlmBudgetCapUnlimited')}
                </p>
              </div>
            </>
          )}
        </div>
        {!isBeginner && budgetUsagePercent !== null && (
          <div className="mt-3">
            <div className="h-2 w-full overflow-hidden rounded bg-muted">
              <div
                className={`h-full ${
                  budgetUsagePercent >= 100
                    ? 'bg-destructive'
                    : budgetUsagePercent >= 80
                      ? 'bg-amber-500'
                      : 'bg-info'
                }`}
                style={{ width: `${budgetUsagePercent}%` }}
              />
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {t('usageLlmBudgetUsage', { percent: budgetUsagePercent })}
            </p>
          </div>
        )}

        {/* ADR-0030 (2026-05-30): LLM 用月次予算上限フォーム (= 概要タブから移動、co-located)。
            Beginner は固定の月 50 回上限のため非表示 (= 既存仕様継承)。 */}
        {!isBeginner && (
          <BudgetCapForm
            kind="llm"
            currentValueJpy={info.monthlyBudgetCapJpy}
            unitPriceJpy={info.plan === 'pro' ? info.pricePerCallSonnet : info.pricePerCallHaiku}
            unitPriceLabel={info.plan === 'pro' ? 'Pro ¥15/call' : 'Expert ¥10/call'}
            onUpdate={onUpdate}
          />
        )}
      </section>

      {/* ============================================================
          Embedding 生成回数 セクション (旧「Embedding 利用量」、ADR-0030 でリネーム)
          ============================================================ */}
      <section
        className="rounded border p-4"
        title={t('usageEmbeddingSectionTooltip')}
        data-testid="usage-embedding-section"
      >
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-semibold">
            {t('usageEmbeddingSectionTitle')}
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              {t('usageEmbeddingSectionSubtitle')}
            </span>
          </h2>
        </div>
        <p className="mb-2 text-xs text-muted-foreground">
          {isBeginner
            ? t('usageEmbeddingBeginnerNote', { limit: BEGINNER_EMBEDDING_MONTHLY_LIMIT })
            : t('usageEmbeddingPaidNote', { plan: info.plan === 'pro' ? 'Pro' : 'Expert' })}
        </p>
        {/*
          ADR-0028 PR #471 (2026-05-30): ヘルプ・ガイドチャットの embedding (LEARNING_FREE) は
          counter 対象外であることを明示。UI 上から判別できない混乱を防ぐため必須注記。
          関連: KDD §5.X+201 / PER_CALL_COST_BREAKDOWN.md §1.5
        */}
        <p className="mb-2 text-xs text-muted-foreground">
          {t('usageEmbeddingLearningFreeNote')}
        </p>
        <div
          className={
            isBeginner
              ? 'grid grid-cols-1 gap-3 sm:grid-cols-2'
              : 'grid grid-cols-1 gap-3 sm:grid-cols-3'
          }
        >
          <div
            className="cursor-help"
            title={t('usageEmbeddingCallCountTooltip')}
          >
            <p className="text-xs text-muted-foreground">{t('usageEmbeddingCountLabel')}</p>
            <p className="text-xl font-bold">
              {info.currentMonthEmbeddingCallCount.toLocaleString()}
              <span className="ml-1 text-sm font-normal text-muted-foreground">
                {isBeginner ? ` / ${BEGINNER_EMBEDDING_MONTHLY_LIMIT}` : t('usageEmbeddingCountUnit')}
              </span>
            </p>
          </div>

          {isBeginner ? (
            <div
              className="cursor-help"
              title={t('usageEmbeddingRemainingTooltip')}
            >
              <p className="text-xs text-muted-foreground">{t('usageEmbeddingRemainingLabel')}</p>
              <p
                className={`text-xl font-bold ${
                  beginnerEmbeddingCallsRemaining === 0
                    ? 'text-destructive'
                    : beginnerEmbeddingCallsRemaining <= 10
                      ? 'text-amber-600'
                      : ''
                }`}
              >
                {beginnerEmbeddingCallsRemaining.toLocaleString()}
                <span className="ml-1 text-sm font-normal text-muted-foreground">{t('usageEmbeddingRemainingUnit')}</span>
              </p>
            </div>
          ) : (
            <>
              <div
                className="cursor-help"
                title={t('usageEmbeddingCostTooltip')}
              >
                <p className="text-xs text-muted-foreground">{t('usageEmbeddingCostLabel')}</p>
                <p className="text-xl font-bold">
                  ¥{info.currentMonthEmbeddingCostJpy.toLocaleString()}
                </p>
              </div>
              <div
                className="cursor-help"
                title={t('usageEmbeddingBudgetCapTooltip')}
              >
                <p className="text-xs text-muted-foreground">{t('usageEmbeddingBudgetCapLabel')}</p>
                <p className="text-xl font-bold">
                  {info.monthlyEmbeddingBudgetCapJpy != null
                    ? `¥${info.monthlyEmbeddingBudgetCapJpy.toLocaleString()}`
                    : t('usageEmbeddingUnlimited')}
                </p>
              </div>
            </>
          )}
        </div>
        {!isBeginner && embeddingBudgetUsagePercent !== null && (
          <div className="mt-3">
            <div className="h-2 w-full overflow-hidden rounded bg-muted">
              <div
                className={`h-full ${
                  embeddingBudgetUsagePercent >= 100
                    ? 'bg-destructive'
                    : embeddingBudgetUsagePercent >= 80
                      ? 'bg-amber-500'
                      : 'bg-info'
                }`}
                style={{ width: `${embeddingBudgetUsagePercent}%` }}
              />
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {t('usageEmbeddingBudgetUsage', { percent: embeddingBudgetUsagePercent })}
            </p>
          </div>
        )}

        {/* ADR-0030 (2026-05-30): Embedding 用月次予算上限フォーム (新設)。
            Beginner は固定の月 100 件試用上限のため非表示。 */}
        {!isBeginner && (
          <BudgetCapForm
            kind="embedding"
            currentValueJpy={info.monthlyEmbeddingBudgetCapJpy}
            unitPriceJpy={EMBEDDING_UNIT_PRICE_JPY}
            unitPriceLabel={t('usageEmbeddingUnitPriceLabel', { price: EMBEDDING_UNIT_PRICE_JPY })}
            onUpdate={onUpdate}
          />
        )}
      </section>
    </>
  );
}

// ADR-0030 (2026-05-30): Embedding 単価は EMBEDDING_PRICE_JPY_BY_PLAN.expert を採用 (= Pro と同単価)。
//   embedding-pricing.ts は Prisma を import しない client-safe モジュールのため直接 import 可。
const EMBEDDING_UNIT_PRICE_JPY = EMBEDDING_PRICE_JPY_BY_PLAN.expert; // ADR-0029 (= 5)

/**
 * ADR-0030 (2026-05-30): 月次予算上限フォーム (LLM 用 / Embedding 用 で再利用)。
 *
 * Beginner は固定上限で運用されるため呼出側で非表示にする想定 (= props 渡し前にガード)。
 * 独立フォーム + PATCH /api/tenants/me 経由で即時反映、成功時に onUpdate で親 state を再取得。
 * 金額入力時は単価で除算した「約 N 回」換算を併記し、ユーザの予算感覚を補助する。
 */
function BudgetCapForm({
  kind,
  currentValueJpy,
  unitPriceJpy,
  unitPriceLabel,
  onUpdate,
}: {
  kind: 'llm' | 'embedding';
  currentValueJpy: number | null;
  unitPriceJpy: number;
  unitPriceLabel: string;
  onUpdate: () => Promise<void>;
}) {
  const t = useTranslations('tenantSettings');
  const { showSuccess, showError } = useToast();
  const [unlimited, setUnlimited] = useState(currentValueJpy == null);
  const [value, setValue] = useState<string>(currentValueJpy != null ? String(currentValueJpy) : '');
  const [submitting, setSubmitting] = useState(false);
  // React docs「prop 変化時に state をリセット」パターンで currentValueJpy 外部更新を反映 (= refreshInfo 後の同期)。
  //   useEffect + setState ではなく render 中の同期更新で cascading render を避ける (react-hooks/set-state-in-effect)。
  const [prevCurrentValueJpy, setPrevCurrentValueJpy] = useState(currentValueJpy);
  if (prevCurrentValueJpy !== currentValueJpy) {
    setPrevCurrentValueJpy(currentValueJpy);
    setUnlimited(currentValueJpy == null);
    setValue(currentValueJpy != null ? String(currentValueJpy) : '');
  }

  const fieldName = kind === 'llm' ? 'monthlyBudgetCapJpy' : 'monthlyEmbeddingBudgetCapJpy';
  const headingSuffix = kind === 'llm' ? t('budgetCapHeadingLlm') : t('budgetCapHeadingEmbedding');
  const description =
    kind === 'llm'
      ? t('budgetCapDescriptionLlm')
      : t('budgetCapDescriptionEmbedding');

  const parsedNumber = Number(value);
  const isValidNumber = !unlimited && value !== '' && Number.isFinite(parsedNumber) && parsedNumber >= 0;
  const approxCalls = isValidNumber && unitPriceJpy > 0 ? Math.floor(parsedNumber / unitPriceJpy) : null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!unlimited && !isValidNumber) {
      showError(t('budgetCapErrorInvalidNumber'));
      return;
    }
    const nextValue = unlimited ? null : parsedNumber;
    if (nextValue === currentValueJpy) {
      showError(t('budgetCapErrorNoChange'));
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch('/api/tenants/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [fieldName]: nextValue }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => null);
        showError(json?.error?.message ?? t('budgetCapErrorSaveFailed'));
        return;
      }
      showSuccess(t('budgetCapSuccessSaved'));
      await onUpdate();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="mt-4 border-t pt-3 space-y-2"
      data-testid={`budget-cap-form-${kind}`}
    >
      <h3 className="text-sm font-semibold">
        {t('budgetCapFormTitle')} {headingSuffix}
      </h3>
      <p className="text-xs text-muted-foreground">{description}</p>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={unlimited}
          onChange={(e) => setUnlimited(e.target.checked)}
          data-testid={`budget-cap-unlimited-${kind}`}
        />
        <span>{t('budgetCapUnlimitedLabel')}</span>
      </label>
      {!unlimited && (
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="number"
            min={0}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="w-48 rounded border p-2"
            placeholder={t('budgetCapPlaceholder')}
            data-testid={`budget-cap-value-${kind}`}
          />
          <span className="text-sm text-muted-foreground">{t('budgetCapCurrencyUnit')}</span>
          {approxCalls !== null && (
            <span className="text-xs text-muted-foreground">
              {t('budgetCapApproxCalls', { count: approxCalls.toLocaleString(), unitPriceLabel })}
            </span>
          )}
        </div>
      )}
      <div>
        <Button type="submit" size="sm" disabled={submitting}>
          {submitting ? t('budgetCapSubmittingLabel') : t('budgetCapSubmitLabel')}
        </Button>
      </div>
    </form>
  );
}

/**
 * ADR-0030 (2026-05-30): 請求タブ「今月請求金額」セクション。
 *
 * 請求 invariant ([[feedback_billing_invariant]]):
 *   LLM + Embedding + DB 容量超過想定 + Storage 超過想定 = 表示合計 = 月末請求書根拠。
 *   月末 cron で DB / Storage 超過を ApiCallLog INSERT して確定するまでの暫定値 (= 月中 peak ベース)。
 */
function MonthlyBillingTotalSection({ info }: { info: TenantSelfInfo }) {
  const t = useTranslations('tenantSettings');
  const llm = info.currentMonthApiCostJpy;
  const embedding = info.currentMonthEmbeddingCostJpy;
  const dbOverage = info.estimatedDbCapacityOverageJpy;
  const storageOverage = info.estimatedFileStorageOverageJpy;
  const total = llm + embedding + dbOverage + storageOverage;

  return (
    <section
      className="rounded border p-4"
      title={t('billingTotalSectionTooltip')}
      data-testid="monthly-billing-total-section"
    >
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-semibold">{t('monthlyBillingTitle')}</h2>
        <span className="text-xs text-muted-foreground">
          {t('monthlyBillingNote')}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="cursor-help" title={t('billingTotalLlmTooltip')}>
          <p className="text-xs text-muted-foreground">{t('monthlyBillingLlmLabel')}</p>
          <p className="text-lg font-semibold">¥{llm.toLocaleString()}</p>
        </div>
        <div className="cursor-help" title={t('billingTotalEmbeddingTooltip')}>
          <p className="text-xs text-muted-foreground">{t('monthlyBillingEmbeddingLabel')}</p>
          <p className="text-lg font-semibold">¥{embedding.toLocaleString()}</p>
        </div>
        <div className="cursor-help" title={t('billingTotalDbTooltip')}>
          <p className="text-xs text-muted-foreground">{t('monthlyBillingDbLabel')}</p>
          <p className="text-lg font-semibold">¥{dbOverage.toLocaleString()}</p>
        </div>
        <div className="cursor-help" title={t('billingTotalStorageTooltip')}>
          <p className="text-xs text-muted-foreground">{t('monthlyBillingStorageLabel')}</p>
          <p className="text-lg font-semibold">¥{storageOverage.toLocaleString()}</p>
        </div>
      </div>
      <div className="mt-4 border-t pt-3">
        <div className="flex items-baseline justify-between">
          <span className="text-sm text-muted-foreground">{t('monthlyBillingTotalLabel')}</span>
          <span className="text-2xl font-bold" data-testid="monthly-billing-total">
            ¥{total.toLocaleString()}
          </span>
        </div>
      </div>
    </section>
  );
}

// ================================================================
// テナント解約セクション (2026-05-08)
// ================================================================

function SelfDeleteTenantSection({ tenantName }: { tenantName: string }) {
  const t = useTranslations('tenantSettings');
  const router = useRouter();
  const { showSuccess, showError } = useToast();
  const [confirmName, setConfirmName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const isMatch = confirmName === tenantName;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (!isMatch) {
      setError(t('selfDeleteErrorNameMismatch'));
      return;
    }
    const ok = window.confirm(t('selfDeleteConfirm', { tenantName }));
    if (!ok) return;

    setSubmitting(true);
    try {
      const res = await fetch('/api/tenants/me/self-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tenantName: confirmName }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        const msg = json?.error?.message ?? t('selfDeleteErrorFailed');
        setError(msg);
        showError(msg);
        return;
      }
      showSuccess(t('selfDeleteSuccess'));
      // fix/session-clearance (2026-05-20): NextAuth 既定 `/api/auth/signout` を自前
      //   `/api/auth/explicit-signout` に統一 (KDD §5.X+84)。
      //   テナント解約時はサーバ側でユーザの deletedAt も同時にセットされるため
      //   `getAuthenticatedUser` / `requireAuthForLayout` が deletedAt 検査で確実に弾くが、
      //   一貫性 + UX (cookie 完全削除) のため明示的にこちらを使う。
      //   fetch 失敗時もテナント自体は削除済み (server-side で認証無効) のため、
      //   navigate は実施する (上記 logout button とは事故影響度が異なる)。
      await fetch('/api/auth/explicit-signout', { method: 'POST' }).catch(() => undefined);
      router.replace('/login');
      router.refresh();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    // feat/tenant-settings-tabs (2026-05-22): 「概要内のまま折りたたみ」のユーザ確定方針に従い、
    //   <details> でラップしデフォルト閉じる。誤クリック防止 + 概要タブの視覚的圧縮を兼ねる。
    //   summary を destructive 色で明示し、解約導線が隠れていないことを示す。
    <details
      className="mt-8 rounded border border-destructive/40 [&[open]>summary]:border-b [&[open]>summary]:border-destructive/40"
      data-testid="self-delete-tenant-section"
    >
      <summary className="cursor-pointer p-4 text-lg font-semibold text-destructive select-none">
        {t('selfDeleteSummary')}
      </summary>
      <div className="space-y-3 p-4">
        <p className="text-sm text-muted-foreground">
          {t('selfDeleteDescription')}
        </p>
        <ul className="ml-4 list-disc text-xs text-muted-foreground">
          <li>{t('selfDeleteBullet1')}</li>
          <li>{t('selfDeleteBullet2')}</li>
          <li>{t('selfDeleteBullet3')}</li>
          <li>{t('selfDeleteBullet4')}</li>
        </ul>

        <form onSubmit={handleSubmit} className="mt-3 space-y-2">
          <label className="block text-sm font-medium">
            {t('selfDeleteConfirmLabel', { tenantName })}
          </label>
          <input
            type="text"
            value={confirmName}
            onChange={(e) => setConfirmName(e.target.value)}
            placeholder={tenantName}
            className="block w-full rounded border p-2 text-sm"
            disabled={submitting}
          />
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button type="submit" variant="destructive" disabled={submitting || !isMatch}>
            {submitting ? t('selfDeleteSubmittingLabel') : t('selfDeleteSubmitLabel')}
          </Button>
        </form>
      </div>
    </details>
  );
}


// ================================================================
// P-C (2026-05-08): データエクスポートセクション
// ================================================================

function DataExportSection() {
  const t = useTranslations('tenantSettings');
  return (
    <section className="mt-8 space-y-3 rounded border p-4">
      <h2 className="text-lg font-semibold">{t('dataExportTitle')}</h2>
      <p className="text-sm text-muted-foreground">
        {t('dataExportDescription')}
      </p>
      <ul className="ml-4 list-disc text-xs text-muted-foreground">
        <li>{t('dataExportBullet1')}</li>
        <li>{t('dataExportBullet2')}</li>
        <li>{t('dataExportBullet3')}</li>
        <li>{t('dataExportBullet4')}</li>
      </ul>
      <a
        href="/api/tenants/me/export"
        className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-xs hover:bg-primary/90"
        download
      >
        {t('dataExportDownloadButton')}
      </a>
    </section>
  );
}

// ================================================================
// P-D (2026-05-08): データインポートセクション
// ================================================================

function DataImportSection() {
  const t = useTranslations('tenantSettings');
  const router = useRouter();
  const { showSuccess, showError } = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [resultSummary, setResultSummary] = useState<{
    importedAt: string;
    counts: Record<string, number>;
  } | null>(null);
  const [error, setError] = useState<string>('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setResultSummary(null);
    if (!file) {
      setError(t('dataImportErrorNoFile'));
      return;
    }
    if (!file.name.toLowerCase().endsWith('.zip')) {
      setError(t('dataImportErrorNotZip'));
      return;
    }
    const ok = window.confirm(t('dataImportConfirm'));
    if (!ok) return;

    setSubmitting(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch('/api/tenants/me/import', {
        method: 'POST',
        body: formData,
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.ok) {
        const message = json?.error?.message ?? t('dataImportErrorFailed');
        setError(message);
        showError(message);
        return;
      }
      setResultSummary({
        importedAt: json.summary.importedAt,
        counts: json.summary.counts,
      });
      showSuccess(t('dataImportSuccess'));
      router.refresh();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="mt-8 space-y-3 rounded border p-4">
      <h2 className="text-lg font-semibold">{t('dataImportTitle')}</h2>

      <details className="rounded border bg-muted/20 p-3 text-xs text-muted-foreground">
        <summary className="cursor-pointer font-semibold text-foreground">{t('dataImportCautionSummary')}</summary>
        <ul className="ml-4 mt-2 list-disc space-y-1">
          <li>{t('dataImportCautionBullet1')}</li>
          <li>{t('dataImportCautionBullet2')}</li>
          <li>{t('dataImportCautionBullet3')}</li>
          <li>{t('dataImportCautionBullet4')}</li>
          <li>{t('dataImportCautionBullet5')}</li>
        </ul>
      </details>

      <p className="text-sm text-muted-foreground">{t('dataImportChooseHint')}</p>
      <ul className="ml-4 list-disc space-y-1 text-sm text-muted-foreground">
        <li><strong>{t('dataImportOption1Title')}</strong> {t('dataImportOption1Desc')}</li>
        <li><strong>{t('dataImportOption2Title')}</strong> {t('dataImportOption2Desc')}</li>
        <li><strong>{t('dataImportOption3Title')}</strong> {t('dataImportOption3Desc')}</li>
      </ul>

      <div className="mt-3 rounded border-l-4 border-amber-400 bg-amber-50 p-3 text-xs dark:bg-amber-900/20">
        <p className="font-semibold">{t('dataImportCsvSectionTitle')}</p>
        <p className="mt-1 text-muted-foreground">
          {t('dataImportCsvSectionDesc')}
        </p>
        <ol className="ml-4 mt-1 list-decimal space-y-1 text-muted-foreground">
          <li>
            <a href="/settings/tenant/migration-import" className="text-info underline">{t('dataImportCsvLinkLabel')}</a>{t('dataImportCsvStep1Suffix')}
          </li>
          <li>{t('dataImportCsvStep2')}</li>
        </ol>
      </div>

      <div className="mt-3 rounded border-l-4 border-emerald-400 bg-emerald-50 p-3 text-xs dark:bg-emerald-900/20">
        <p className="font-semibold">{t('dataImportApiSectionTitle')}</p>
        <p className="mt-1 text-muted-foreground">
          {t('dataImportApiSectionDesc1')}
          {' '}
          <a href="/settings/tenant/api-import" className="text-info underline">{t('dataImportApiLinkLabel')}</a>
          {t('dataImportApiSectionDesc2')}
        </p>
      </div>

      <div className="mt-3 rounded border-l-4 border-info bg-info/5 p-3 text-sm">
        <p className="mb-1 font-semibold">{t('dataImportZipSectionTitle')}</p>
        <p className="mb-2 text-xs text-muted-foreground">
          {t('dataImportZipSectionDesc')}
        </p>
        <ol className="ml-4 list-decimal space-y-1.5 text-xs">
          <li><strong>{t('dataImportZipStep1Title')}</strong>: {t('dataImportZipStep1Desc')}</li>
          <li><strong>{t('dataImportZipStep2Title')}</strong>: {t('dataImportZipStep2Desc')}</li>
          <li><strong>{t('dataImportZipStep3Title')}</strong>: {t('dataImportZipStep3Desc')}</li>
          <li><strong>{t('dataImportZipStep4Title')}</strong>: {t('dataImportZipStep4Desc')}</li>
        </ol>

        <form onSubmit={handleSubmit} className="mt-3 space-y-3">
        <div>
          <label htmlFor="import-zip" className="text-sm font-medium">
            {t('dataImportZipFileLabel')}
            <span className="ml-2 text-xs text-muted-foreground">{t('dataImportZipFileHint')}</span>
          </label>
          <input
            id="import-zip"
            type="file"
            accept=".zip,application/zip"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="mt-1 block w-full text-sm"
            disabled={submitting}
          />
          {file && (
            <p className="mt-1 text-xs text-muted-foreground">
              {t('dataImportZipFileSelected', { name: file.name, sizeKb: Math.round(file.size / 1024).toLocaleString() })}
            </p>
          )}
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button type="submit" disabled={submitting || !file}>
          {submitting ? t('dataImportSubmittingLabel') : t('dataImportSubmitLabel')}
        </Button>
      </form>

      {resultSummary && (
        <div className="mt-3 rounded bg-muted/50 p-3 text-xs">
          <p className="font-semibold">{t('dataImportResultTitle', { importedAt: resultSummary.importedAt })}</p>
          <ul className="ml-4 list-disc">
            <li>{t('dataImportResultProjects', { count: resultSummary.counts.projects })}</li>
            <li>{t('dataImportResultTasks', { count: resultSummary.counts.tasks })}</li>
            <li>{t('dataImportResultKnowledge', { count: resultSummary.counts.knowledge })}</li>
            <li>{t('dataImportResultRisksIssues', { count: resultSummary.counts.risksIssues })}</li>
            <li>{t('dataImportResultRetrospectives', { count: resultSummary.counts.retrospectives })}</li>
            <li>{t('dataImportResultMemos', { count: resultSummary.counts.memos })}</li>
            <li>{t('dataImportResultCustomers', { count: resultSummary.counts.customers })}</li>
            <li>{t('dataImportResultUsersCreated', { count: resultSummary.counts.usersCreated })}</li>
            <li>{t('dataImportResultUsersMerged', { count: resultSummary.counts.usersMerged })}</li>
          </ul>
        </div>
      )}
      </div>
    </section>
  );
}

// ================================================================
// 2026-05-09 (PR G / #24): シードデータ参照 toggle セクション
// ================================================================

// ================================================================
// feat/starter-data-import (2026-06-05): スターターデータ一括取込/削除セクション
// ================================================================

function SampleDataSection({
  plan,
  onUpdate,
}: {
  plan: 'beginner' | 'expert' | 'pro';
  onUpdate: () => Promise<void>;
}) {
  const t = useTranslations('tenantSettings');
  const { showSuccess, showError } = useToast();
  const [submitting, setSubmitting] = useState(false);

  async function handleImport() {
    // Expert/Pro は取込データ分の DB 容量が従量課金対象になるため、確認ダイアログで承認を取る。
    //   Beginner は 50MB 無料枠を超える場合のみサーバ側でブロックされる (確認は不要)。
    if (plan !== 'beginner') {
      const ok = window.confirm(t('sampleDataImportConfirm'));
      if (!ok) return;
    }
    setSubmitting(true);
    try {
      const res = await fetch('/api/tenants/me/sample-data', { method: 'POST' });
      const json = (await res.json().catch(() => null)) as {
        summary?: { customers: number; projects: number; knowledge: number; risksIssues: number; retrospectives: number };
        error?: { message?: string };
      } | null;
      if (!res.ok) {
        showError(json?.error?.message ?? t('sampleDataImportErrorFailed'));
        return;
      }
      const s = json?.summary;
      showSuccess(
        s
          ? t('sampleDataImportSuccessDetail', { customers: s.customers, projects: s.projects, knowledge: s.knowledge, risksIssues: s.risksIssues, retrospectives: s.retrospectives })
          : t('sampleDataImportSuccess'),
      );
      await onUpdate();
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete() {
    const ok = window.confirm(t('sampleDataDeleteConfirm'));
    if (!ok) return;
    setSubmitting(true);
    try {
      const res = await fetch('/api/tenants/me/sample-data', { method: 'DELETE' });
      const json = (await res.json().catch(() => null)) as {
        summary?: { customers: number; projects: number; knowledge: number; risksIssues: number; retrospectives: number };
      } | null;
      if (!res.ok) {
        showError(t('sampleDataDeleteErrorFailed'));
        return;
      }
      const s = json?.summary;
      const total = s ? s.customers + s.projects + s.knowledge + s.risksIssues + s.retrospectives : 0;
      showSuccess(t('sampleDataDeleteSuccess', { total }));
      await onUpdate();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="mt-8 rounded border p-4" data-testid="sample-data-section">
      <h2 className="text-lg font-semibold">{t('sampleDataTitle')}</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        {t('sampleDataDescription')}
      </p>
      <div className="mt-3 flex flex-wrap gap-3">
        <Button type="button" onClick={handleImport} disabled={submitting} data-testid="sample-data-import">
          {t('sampleDataImportButton')}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={handleDelete}
          disabled={submitting}
          data-testid="sample-data-delete"
        >
          {t('sampleDataDeleteButton')}
        </Button>
      </div>
    </section>
  );
}

// ================================================================
// P-G: 請求先情報の編集セクション
// ================================================================

function BillingContactSection({
  initialInfo,
  stripeEnabled,
  onUpdate,
  onDirtyChange,
}: {
  initialInfo: TenantSelfInfo;
  /**
   * feat/credit-card-ui-guard (2026-05-30): Stripe feature flag。
   * false の場合、credit_card option を選択不可にして 403 エラーの誤誘発を防ぐ
   * (= STRIPE_DISABLED 状態で UI と Server の整合性を担保、KDD §5.X+184 参照)。
   */
  stripeEnabled: boolean;
  /**
   * PR #425 (2026-05-22) ★severity-1★: 更新成功後に親の info state を再取得する callback。
   * paymentMethod 変更が StripePaymentMethodSection のボタン活性条件に即時反映されないと
   * 「credit_card 払いだがカード未登録」状態が放置され請求漏れ発生する。
   */
  onUpdate: () => Promise<void>;
  /**
   * feat/tenant-settings-tabs (2026-05-22): 親 (TenantSettingsClient) に「請求先情報フォームに
   * 未保存変更があるか」を通知する callback。タブ切替前の確認ダイアログ表示に使う。
   * 親の ref を更新するだけのため、引数は単純な boolean。
   */
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const t = useTranslations('tenantSettings');
  const router = useRouter();
  const { showSuccess, showError } = useToast();

  // 2026-05-09 (PR C / #5/#8/#10): 個人/法人 + 住所サブフィールドを追加
  const [form, setForm] = useState({
    billingType: (initialInfo.billingType as 'corporate' | 'individual') || 'corporate',
    billingCompanyName: initialInfo.billingCompanyName ?? '',
    billingContactName: initialInfo.billingContactName ?? '',
    billingContactEmail: initialInfo.billingContactEmail ?? '',
    billingPostalCode: initialInfo.billingPostalCode ?? '',
    billingPrefecture: initialInfo.billingPrefecture ?? '',
    billingCity: initialInfo.billingCity ?? '',
    billingStreetAddress: initialInfo.billingStreetAddress ?? '',
    billingBuildingName: initialInfo.billingBuildingName ?? '',
    billingPhoneNumber: initialInfo.billingPhoneNumber ?? '',
    // 2026-05-15: 旧 'bank_transfer' 値は 'invoice' に正規化 (UI ラベル「銀行振込」に統合)。
    //   API バリデーションで bank_transfer は reject されるため、フォーム初期化時点で invoice に揃える。
    paymentMethod: initialInfo.paymentMethod === 'bank_transfer' ? 'invoice' : (initialInfo.paymentMethod || 'invoice'),
  });
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // feat/tenant-settings-tabs (2026-05-22): タブ切替ガード用の dirty 通知。
  //   baseline は「最後に保存成功した値」とし、submit 成功時に form 自身で更新する。
  //   useRef なので比較自体は再 render を発生させず、副次的に effect が走るのは
  //   onDirtyChange (= 親 ref の代入) を呼ぶ瞬間のみ。
  const baselineFormRef = useRef(form);
  useEffect(() => {
    if (!onDirtyChange) return;
    const dirty = JSON.stringify(form) !== JSON.stringify(baselineFormRef.current);
    onDirtyChange(dirty);
  }, [form, onDirtyChange]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setSubmitting(true);

    // PR #425 (2026-05-22) ★severity-1 請求堅牢性★:
    //   paymentMethod を「非 credit_card → credit_card」に変更した場合、
    //   その瞬間に Stripe Checkout setup に強制遷移する。これにより
    //   「カード未登録だが DB は credit_card」という請求漏れ状態が構造的に発生しない。
    //
    //   フロー:
    //     1) フォーム送信ボタン押下
    //     2) paymentMethod 以外のフィールドだけ DB に保存 (= 住所変更も同時に救う)
    //     3) POST /api/.../stripe/setup → Checkout URL 取得
    //     4) window.location.href で Stripe Checkout に遷移
    //     5) カード登録成功 → /api/.../stripe/setup/complete が
    //        completeStripeSetup() を呼び出し、その中で paymentMethod='credit_card' を DB に書き込む
    //     6) /settings/tenant?stripe_setup=success に戻り、StripePaymentMethodSection が「✓有効」表示
    //
    //   失敗/キャンセル時: paymentMethod は invoice のまま (= 何も壊れない)
    const previousPaymentMethod =
      initialInfo.paymentMethod === 'bank_transfer' ? 'invoice' : (initialInfo.paymentMethod || 'invoice');
    const isInvoiceToCreditCardTransition =
      previousPaymentMethod !== 'credit_card' && form.paymentMethod === 'credit_card';

    try {
      // 共通: paymentMethod 以外のフィールドを DB 更新
      //   credit_card への切替時は paymentMethod を body から除外して
      //   server-side ガード (CreditCardNotRegisteredError) を回避する。
      //   その後 Stripe Checkout 遷移で completeStripeSetup が paymentMethod を書き込む。
      const bodyForPatch = {
        ...form,
        billingCompanyName:
          form.billingType === 'individual'
            ? null
            : form.billingCompanyName.trim() || null,
        billingBuildingName: form.billingBuildingName.trim() || null,
        billingPhoneNumber: form.billingPhoneNumber.trim() || null,
      };
      if (isInvoiceToCreditCardTransition) {
        // paymentMethod は完了経路で書き込むので、ここでは送らない
        delete (bodyForPatch as Partial<typeof bodyForPatch>).paymentMethod;
      }

      const res = await fetch('/api/tenants/me/billing', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bodyForPatch),
      });

      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        const code = json?.error?.code as string | undefined;
        const message = json?.error?.message as string | undefined;
        if (code === 'VALIDATION_ERROR') setError(message ?? t('billingContactErrorValidation'));
        else if (code === 'CREDIT_CARD_NOT_REGISTERED') {
          setError(
            message ??
              t('billingContactErrorCreditCardNotRegistered'),
          );
        } else setError(message ?? t('billingContactErrorUpdateFailed'));
        showError(t('billingContactErrorUpdateFailed'));
        return;
      }

      // PR #425 (2026-05-22) 強制遷移: 非 credit_card → credit_card 変更時
      if (isInvoiceToCreditCardTransition) {
        // PR #425 (2026-05-22) UX 改善: まず「既存カード」での再 setup を試みる。
        //   既存カード (= Stripe Customer の invoice_settings.default_payment_method) があれば、
        //   Stripe Checkout を経由せず即 Subscription を作成 (= 1 クリックで完了)。
        //   既存カードなし (= 404 NO_EXISTING_CARD) なら通常の Stripe Checkout 強制遷移にフォールバック。
        const existingCardRes = await fetch('/api/tenants/me/billing/stripe/setup-with-existing-card', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        });
        const existingCardJson = await existingCardRes.json().catch(() => ({}));
        if (existingCardRes.ok && existingCardJson.data?.ok) {
          // 既存カードで Subscription 作成成功 → UI 更新のみ
          showSuccess(t('billingContactSuccessExistingCard'));
          await onUpdate();
          router.refresh();
          return;
        }
        // 既存カードなし or 失敗 → Stripe Checkout 強制遷移にフォールバック
        // feat/tenant-settings-tabs (2026-05-22): カード登録完了後は請求タブへ戻す。
        const returnUrl = `${window.location.origin}/settings/tenant?tab=billing`;
        const setupRes = await fetch('/api/tenants/me/billing/stripe/setup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ returnUrl }),
        });
        const setupJson = await setupRes.json().catch(() => ({}));
        if (!setupRes.ok || setupJson.data?.checkoutUrl == null) {
          showError(setupJson?.error?.message ?? t('billingContactErrorStripeSetupFailed'));
          // paymentMethod は DB 上 invoice のままなので状態は壊れていない
          await onUpdate();
          router.refresh();
          return;
        }
        // 住所等は既に保存済みである旨を伝えてから遷移
        showSuccess(t('billingContactSuccessStripeRedirect'));
        // feat/tenant-settings-tabs (2026-05-22): Stripe 遷移直前で baseline を更新しておく。
        //   万一遷移が阻まれた場合 (browser dialog cancel など) でも dirty 扱いを残さない。
        baselineFormRef.current = form;
        onDirtyChange?.(false);
        window.location.href = setupJson.data.checkoutUrl;
        return;
      }

      showSuccess(t('billingContactSuccessUpdated'));
      // feat/tenant-settings-tabs (2026-05-22): 保存成功 = baseline 更新。
      //   以降の編集が再び dirty 扱いになる。
      baselineFormRef.current = form;
      onDirtyChange?.(false);
      // PR #425 (2026-05-22) ★severity-1★: 親の info state を再取得して paymentMethod を即時反映。
      //   router.refresh() だけでは Client Component の useState 値は変わらないため、
      //   StripePaymentMethodSection の活性条件 (info.paymentMethod === 'credit_card') に
      //   反映されず、credit_card 払いなのにカード未登録のまま放置される請求漏れリスクが発生する。
      await onUpdate();
      router.refresh();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="mt-8 space-y-4 rounded border p-4">
      <h2 className="text-lg font-semibold">{t('billingContactTitle')}</h2>
      <p className="text-xs text-muted-foreground">
        {t('billingContactDescription')}
      </p>

      {error && (
        <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>
      )}

      {/* 2026-05-09 (PR C / #5): 個人 / 法人 切替 */}
      <div className="space-y-2">
        <span className="text-sm font-medium">{t('billingContactTypeLabel')}</span>
        <div className="flex gap-4 text-sm">
          <label className="flex items-center gap-1.5">
            <input
              type="radio"
              name="billingType"
              value="corporate"
              checked={form.billingType === 'corporate'}
              onChange={() => setForm({ ...form, billingType: 'corporate' })}
            />
            {t('billingContactTypeCorporate')}
          </label>
          <label className="flex items-center gap-1.5">
            <input
              type="radio"
              name="billingType"
              value="individual"
              checked={form.billingType === 'individual'}
              onChange={() => setForm({ ...form, billingType: 'individual', billingCompanyName: '' })}
            />
            {t('billingContactTypeIndividual')}
          </label>
        </div>
      </div>

      {form.billingType === 'corporate' && (
        <div className="space-y-2">
          <label htmlFor="billingCompanyName" className="text-sm font-medium">{t('billingContactCompanyNameLabel')}</label>
          <input
            id="billingCompanyName"
            className="w-full rounded border p-2 text-sm"
            value={form.billingCompanyName}
            onChange={(e) => setForm({ ...form, billingCompanyName: e.target.value })}
            maxLength={200}
            required
          />
        </div>
      )}

      <div className="space-y-2">
        <label htmlFor="billingContactName" className="text-sm font-medium">
          {form.billingType === 'corporate' ? t('billingContactPersonNameCorporateLabel') : t('billingContactPersonNameIndividualLabel')}
        </label>
        <input
          id="billingContactName"
          className="w-full rounded border p-2 text-sm"
          value={form.billingContactName}
          onChange={(e) => setForm({ ...form, billingContactName: e.target.value })}
          maxLength={100}
          required
        />
      </div>

      <div className="space-y-2">
        <label htmlFor="billingContactEmail" className="text-sm font-medium">{t('billingContactEmailLabel')}</label>
        <input
          id="billingContactEmail"
          type="email"
          className="w-full rounded border p-2 text-sm"
          value={form.billingContactEmail}
          onChange={(e) => setForm({ ...form, billingContactEmail: e.target.value })}
          maxLength={255}
          required
        />
      </div>

      {/* 2026-05-09 (PR C / #8): 住所をサブフィールドに分割 */}
      <div className="space-y-2">
        <label htmlFor="billingPostalCode" className="text-sm font-medium">{t('billingContactPostalCodeLabel')}</label>
        <input
          id="billingPostalCode"
          className="w-full rounded border p-2 text-sm"
          value={form.billingPostalCode}
          onChange={(e) => setForm({ ...form, billingPostalCode: e.target.value })}
          maxLength={10}
          placeholder={t('billingContactPostalCodePlaceholder')}
          pattern="\d{3}-?\d{4}"
          required
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-2">
          <label htmlFor="billingPrefecture" className="text-sm font-medium">{t('billingContactPrefectureLabel')}</label>
          <input
            id="billingPrefecture"
            className="w-full rounded border p-2 text-sm"
            value={form.billingPrefecture}
            onChange={(e) => setForm({ ...form, billingPrefecture: e.target.value })}
            maxLength={20}
            placeholder={t('billingContactPrefecturePlaceholder')}
            required
          />
        </div>
        <div className="space-y-2">
          <label htmlFor="billingCity" className="text-sm font-medium">{t('billingContactCityLabel')}</label>
          <input
            id="billingCity"
            className="w-full rounded border p-2 text-sm"
            value={form.billingCity}
            onChange={(e) => setForm({ ...form, billingCity: e.target.value })}
            maxLength={100}
            placeholder={t('billingContactCityPlaceholder')}
            required
          />
        </div>
      </div>
      <div className="space-y-2">
        <label htmlFor="billingStreetAddress" className="text-sm font-medium">{t('billingContactStreetAddressLabel')}</label>
        <input
          id="billingStreetAddress"
          className="w-full rounded border p-2 text-sm"
          value={form.billingStreetAddress}
          onChange={(e) => setForm({ ...form, billingStreetAddress: e.target.value })}
          maxLength={200}
          placeholder={t('billingContactStreetAddressPlaceholder')}
          required
        />
      </div>
      {/* 2026-05-09 (#10): 任意 */}
      <div className="space-y-2">
        <label htmlFor="billingBuildingName" className="text-sm font-medium">{t('billingContactBuildingNameLabel')}</label>
        <input
          id="billingBuildingName"
          className="w-full rounded border p-2 text-sm"
          value={form.billingBuildingName}
          onChange={(e) => setForm({ ...form, billingBuildingName: e.target.value })}
          maxLength={200}
          placeholder={t('billingContactBuildingNamePlaceholder')}
        />
      </div>

      {/* 2026-05-09 (PR C): legacy billingAddress が残っている場合は read-only で表示 (データ損失防止) */}
      {initialInfo.billingAddress
        && !initialInfo.billingPostalCode
        && !initialInfo.billingPrefecture && (
        <div className="rounded border border-amber-300 bg-amber-50 p-3 text-xs dark:bg-amber-900/30">
          <strong>{t('billingContactLegacyAddressTitle')}</strong>
          <pre className="mt-1 whitespace-pre-wrap font-mono text-xs">{initialInfo.billingAddress}</pre>
          <p className="mt-1">
            {t('billingContactLegacyAddressNote')}
          </p>
        </div>
      )}

      <div className="space-y-2">
        <label htmlFor="billingPhoneNumber" className="text-sm font-medium">{t('billingContactPhoneLabel')}</label>
        <input
          id="billingPhoneNumber"
          className="w-full rounded border p-2 text-sm"
          value={form.billingPhoneNumber}
          onChange={(e) => setForm({ ...form, billingPhoneNumber: e.target.value })}
          maxLength={20}
          placeholder={t('billingContactPhonePlaceholder')}
        />
      </div>

      <div className="space-y-2">
        <label htmlFor="paymentMethod" className="text-sm font-medium">{t('billingContactPaymentMethodLabel')}</label>
        <select
          id="paymentMethod"
          className="w-full rounded border bg-background p-2 text-sm"
          value={form.paymentMethod}
          onChange={(e) => setForm({ ...form, paymentMethod: e.target.value })}
        >
          {/* 2026-05-15: 旧 'invoice'（請求書送付）と 'bank_transfer'（銀行振込）を「銀行振込」に統合 (内部値 'invoice')。
              ユーザから見て同じ運用フローのため 1 選択肢に集約。旧 bank_transfer レコードは初期化時に invoice 正規化。 */}
          <option value="invoice">{t('billingContactPaymentInvoice')}</option>
          {/* PR #425 (2026-05-21): クレジットカード払いを正式対応。選択 + 保存で paymentMethod が
              credit_card に切り替わり、下部「クレジットカード情報更新」ボタンが活性化される。
              credit_card → invoice 戻しは server 側で Stripe Subscription を即時 cancel。

              feat/db-storage-overage-subscription-items (2026-05-30): 5 項目すべての Stripe
              Subscription Item 化を完遂 (Haiku / Sonnet / Embedding / DB 容量超過 / ファイルストレージ超過)。
              テナント表示 = 請求書 = Stripe Invoice 4 経路完全 invariant 一致を担保し、
              feat/credit-card-pending の読み取り専用を解除。

              feat/credit-card-ui-guard (2026-05-30) ★severity-high UX 防御深化★:
              STRIPE_ENABLED=false の場合は option を disabled 化する (= サーバ側 403 ガードと
              整合)。「UI で選べるが保存すると 403」という UX 矛盾を防ぐ二段ガード設計
              (KDD §5.X+184 参照)。 */}
          <option value="credit_card" disabled={!stripeEnabled}>
            {stripeEnabled ? t('billingContactPaymentCreditCard') : t('billingContactPaymentCreditCardDisabled')}
          </option>
        </select>
      </div>

      <Button type="submit" disabled={submitting}>
        {submitting ? t('billingContactSubmittingLabel') : t('billingContactSubmitLabel')}
      </Button>
    </form>
  );
}

// ================================================================
// P-B (2026-05-08): Beginner プラン期限バナー
// ================================================================

/**
 * Beginner プラン契約中のテナントに、残り日数 / 期限切れ警告を表示するバナー。
 * Expert / Pro プラン (= 期限制御対象外) の場合は何も表示しない。
 *
 * 表示パターン:
 *   - active (Day 0〜59): 黄色バナー (= Beginner 試用中、残り日数表示)
 *   - warning_60 (Day 60〜74): 橙バナー (=「残り {N} 日」)
 *   - warning_75 (Day 75〜89): 強橙バナー (= 強い警告。期限後もエクスポートは継続利用可)
 *   - expired (Day 90+): 赤バナー (= 読み取り専用モード明示)
 */
function BeginnerExpiryBanner({ info }: { info: TenantSelfInfo }) {
  const t = useTranslations('tenantSettings');
  if (info.plan !== 'beginner') return null;

  const days = info.beginnerDaysRemaining ?? 0;

  if (info.beginnerExpiryState === 'expired') {
    return (
      <section className="space-y-2 rounded border border-destructive/30 bg-destructive/10 p-4">
        <h2 className="text-base font-semibold text-destructive">
          {t('beginnerExpiryExpiredTitle')}
        </h2>
        <p className="text-sm">
          {t('beginnerExpiryExpiredDescription')}
        </p>
        <ul className="ml-4 list-disc text-sm text-muted-foreground">
          <li>{t('beginnerExpiryExpiredBullet1')}</li>
          <li>{t('beginnerExpiryExpiredBullet2')}</li>
          <li>
            <strong>{t('beginnerExpiryExpiredBullet3')}</strong>
          </li>
        </ul>
        <p className="text-sm">
          {t('beginnerExpiryExpiredUpgradeHint')}
        </p>
      </section>
    );
  }

  if (info.beginnerExpiryState === 'warning_75') {
    return (
      <section className="space-y-2 rounded border border-orange-400 bg-orange-50 p-4 dark:border-orange-900/40 dark:bg-orange-950/30">
        <h2 className="text-base font-semibold text-orange-900 dark:text-orange-200">
          {t('beginnerExpiryWarning75Title', { days })}
        </h2>
        <p className="text-sm text-orange-900 dark:text-orange-200">
          {t('beginnerExpiryWarning75Description')}
        </p>
      </section>
    );
  }

  if (info.beginnerExpiryState === 'warning_60') {
    return (
      <section className="space-y-2 rounded border border-amber-400 bg-amber-50 p-4 dark:border-amber-900/40 dark:bg-amber-950/30">
        <h2 className="text-base font-semibold text-amber-900 dark:text-amber-200">
          {t('beginnerExpiryWarning60Title', { days })}
        </h2>
        <p className="text-sm text-amber-900 dark:text-amber-200">
          {t('beginnerExpiryWarning60Description')}
        </p>
      </section>
    );
  }

  // active (Day 0〜59): 控えめに「試用中」を案内
  return (
    <section className="space-y-1 rounded border border-info/30 bg-info/5 p-3">
      <p className="text-sm">
        <strong>{t('beginnerExpiryActiveTitle')}</strong> {t('beginnerExpiryActiveDays', { days })}
      </p>
      <p className="text-xs text-muted-foreground">
        {t('beginnerExpiryActiveDescription')}
      </p>
    </section>
  );
}

// ================================================================
// PR-1 (2026-05-15): テナント単位の言語・タイムゾーン設定セクション
// ================================================================

/**
 * テナント全体の TZ / locale を変更するフォーム (テナント管理者のみ)。
 *
 * - 旧 `/settings` の i18n セクションを集約。
 * - 設定値は配下全ユーザの日付表示・残日数計算・月初リセット境界に適用される。
 * - 保存後は `/api/tenants/me/i18n` が JWT を再署名 + Set-Cookie し、`router.refresh()` で SSR
 *   経由の即時反映を行う (fix/jwt-resign-for-netlify、2026-05-18 以降)。
 */
function TenantI18nSection({
  initialTimezone,
  initialLocale,
  onUpdate,
}: {
  initialTimezone: string;
  initialLocale: string;
  onUpdate: () => Promise<void>;
}) {
  const t = useTranslations('tenantSettings');
  const router = useRouter();
  const { showSuccess, showError } = useToast();
  // fix/jwt-resign-for-netlify (2026-05-18): useSession().update() は不要になった。
  //   /api/tenants/me/i18n が JWT を再署名 + Set-Cookie するため、router.refresh() のみで反映可能。
  const [tz, setTz] = useState(initialTimezone);
  const [loc, setLoc] = useState(initialLocale);
  const [submitting, setSubmitting] = useState(false);

  // Intl.supportedValuesOf('timeZone') で IANA タイムゾーン名一覧を動的取得 (2022 以降標準)。
  const tzOptions = useMemo<string[]>(() => {
    try {
      const supported = Intl.supportedValuesOf as ((key: 'timeZone') => string[]) | undefined;
      if (typeof supported === 'function') return supported('timeZone');
    } catch {
      // 非対応ブラウザは fallback
    }
    return [
      'UTC',
      'Asia/Tokyo',
      'Asia/Shanghai',
      'Asia/Seoul',
      'America/New_York',
      'America/Los_Angeles',
      'Europe/London',
      'Europe/Paris',
    ];
  }, []);

  const changed = tz !== initialTimezone || loc !== initialLocale;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!changed) {
      showError(t('i18nErrorNoChange'));
      return;
    }
    setSubmitting(true);
    try {
      const body: Record<string, string> = {};
      if (tz !== initialTimezone) body.timezone = tz;
      if (loc !== initialLocale) body.locale = loc;

      const res = await fetch('/api/tenants/me/i18n', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        showError(json?.error?.message ?? t('i18nErrorSaveFailed'));
        return;
      }
      // fix/jwt-resign-for-netlify (2026-05-18):
      //   旧仕様は ここで useSession().update() を呼んで JWT を更新していたが、
      //   NextAuth v5 + @netlify/plugin-nextjs で Set-Cookie が反映されない事象あり。
      //   現在は API ルート側 (`/api/tenants/me/i18n`) が再署名 + Set-Cookie 済なので
      //   クライアントは router.refresh() で SSR 経由の即時反映に依存する。
      showSuccess(t('i18nSuccessSaved'));
      await onUpdate();
      router.refresh();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="mt-8 rounded border p-4">
      <h2 className="mb-2 text-lg font-semibold">{t('i18nTitle')}</h2>
      <p className="mb-3 text-xs text-muted-foreground">
        {t('i18nDescription')}
      </p>
      <form onSubmit={handleSubmit} className="space-y-3">
        <div className="space-y-1">
          <label htmlFor="tenant-i18n-locale" className="text-sm font-medium">
            {t('i18nLocaleLabel')}
          </label>
          <select
            id="tenant-i18n-locale"
            value={loc}
            onChange={(e) => setLoc(e.target.value)}
            className="w-64 rounded border bg-background p-2 text-sm"
          >
            {Object.entries(SUPPORTED_LOCALES).map(([key, label]) => {
              const selectable = SELECTABLE_LOCALES[key as keyof typeof SELECTABLE_LOCALES];
              return (
                <option key={key} value={key} disabled={!selectable}>
                  {label} ({key}){!selectable ? t('i18nLocalePreparing') : ''}
                </option>
              );
            })}
          </select>
        </div>
        <div className="space-y-1">
          <label htmlFor="tenant-i18n-tz" className="text-sm font-medium">
            {t('i18nTimezoneLabel')}
          </label>
          <select
            id="tenant-i18n-tz"
            value={tz}
            onChange={(e) => setTz(e.target.value)}
            className="w-64 rounded border bg-background p-2 text-sm"
          >
            {tzOptions.map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </select>
        </div>
        <Button type="submit" disabled={submitting || !changed}>
          {submitting ? t('i18nSubmittingLabel') : t('i18nSubmitLabel')}
        </Button>
      </form>
    </section>
  );
}
