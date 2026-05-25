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
  /** feat/settings-tenant-identity (2026-05-21): per-call 単価 (¥5 Haiku / ¥15 Sonnet)。 */
  pricePerCallHaiku: number;
  pricePerCallSonnet: number;
  /** feat/settings-tenant-identity (2026-05-21): テナント停止状態 (PR #372)。 */
  suspendedAt: Date | string | null;
  suspendReason: string | null;
  plan: 'beginner' | 'expert' | 'pro';
  monthlyBudgetCapJpy: number | null;
  beginnerMaxSeats: number;
  beginnerMonthlyCallLimit: number;
  currentMonthApiCallCount: number;
  currentMonthApiCostJpy: number;
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
  // 2026-05-09 (PR G / #24): シードデータ参照 toggle
  seedDataEnabled: boolean;
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

type PlanLabel = { value: 'beginner' | 'expert' | 'pro'; label: string; description: string };

// ADR-0019 (2026-05-24): 課金対象を BILLABLE_FEATURE_UNITS (project-upsert /
// suggestion-explanation) のみに限定し、資産入力・チャット検索・自動インポートを全プラン無料化。
// Beginner 上限 100→50 (課金対象 call のみカウント)、Expert ¥5→¥10 / Pro ¥15 据置。
const PLAN_OPTIONS: PlanLabel[] = [
  {
    value: 'beginner',
    label: 'Beginner',
    description: 'プロジェクト作成/更新 月 50 回まで無料・最大 5 席 (資産入力とチャット検索は無料・無制限)',
  },
  {
    value: 'expert',
    label: 'Expert',
    description: 'プロジェクト作成/更新 ¥10/call (資産入力とチャット検索は無料・無制限)',
  },
  {
    value: 'pro',
    label: 'Pro',
    description: 'プロジェクト作成/更新 + なぜ機能 ¥15/call・Claude Sonnet (資産入力とチャット検索は無料)',
  },
];

/**
 * Storage add-on (Phase 2 / 2026-05-08): page.tsx から渡される初期情報。
 * Server Component → Client Component の境界で BigInt と Date を string 化済。
 */
type StorageInitialInfo = {
  tenantId: string;
  llmPlan: 'beginner' | 'expert' | 'pro';
  storageAddonPlan: 'standard' | 'plus' | 'pro_storage' | 'enterprise';
  storageAddonMonthlyJpy: number;
  storageBytesUsed: number;
  storageLimitBytes: number;
  usageRatio: number;
  graceState: 'active' | 'grace_active' | 'write_blocked';
  graceStartedAt: string | null;
  graceDaysRemaining: number | null;
  scheduledStorageAddonAt: string | null;
  scheduledNextStorageAddon: 'standard' | 'plus' | 'pro_storage' | 'enterprise' | null;
  storageBytesUsedAt: string | null;
};

export function TenantSettingsClient({
  initialInfo,
  storageInitialInfo,
  apiReconcile,
  degradedMode,
  stripeEnabled,
  cardSummary,
}: {
  initialInfo: TenantSelfInfo;
  storageInitialInfo: StorageInitialInfo | null;
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
}) {
  // PR-4 (2026-05-15): テナント TZ で日付を表示するため useFormatters を導入
  const { formatDate } = useFormatters();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { showSuccess, showError } = useToast();
  const t = useTranslations('tenantSettings');
  const [info, setInfo] = useState(initialInfo);
  const [selectedPlan, setSelectedPlan] = useState(initialInfo.plan);
  const [budgetCap, setBudgetCap] = useState<string>(
    initialInfo.monthlyBudgetCapJpy != null ? String(initialInfo.monthlyBudgetCapJpy) : '',
  );
  const [budgetUnlimited, setBudgetUnlimited] = useState(initialInfo.monthlyBudgetCapJpy == null);
  const [submitting, setSubmitting] = useState(false);

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
        const ok = confirm('請求先情報に未保存の変更があります。タブを切り替えると入力内容は失われます。続行しますか?');
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
      showSuccess('クレジットカード情報を登録しました');
    } else if (status === 'canceled') {
      showError('クレジットカード情報の登録をキャンセルしました');
    } else if (status === 'failed') {
      const reason = searchParams.get('reason') ?? '';
      const reasonMessageMap: Record<string, string> = {
        card_declined: 'カードが拒否されました',
        expired_card: 'カードの有効期限が切れています',
        processing_error: 'Stripe 処理エラー (時間をおいて再試行)',
        verification_required: 'カード追加認証が必要です',
      };
      const reasonMessage = reasonMessageMap[reason] ?? '不明なエラー';
      showError(`カード登録に失敗しました (${reasonMessage})。設定は変更されていません`);
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
    setBudgetCap(json.data.monthlyBudgetCapJpy != null ? String(json.data.monthlyBudgetCapJpy) : '');
    setBudgetUnlimited(json.data.monthlyBudgetCapJpy == null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (beginnerSeatsExceeded) {
      showError('Beginner プランへの変更には席数を 5 以下に減らす必要があります');
      return;
    }
    if (isDowngrade) {
      // 2026-05-14: Expert↔Pro ダウングレードは即時反映 (旧仕様の翌月予約から変更)。
      //   Pro 限定機能 (「なぜ?」AI 説明等) が即座に使えなくなるため、明示確認は維持。
      //   Beginner ダウングレードは API 側で BEGINNER_DOWNGRADE_FORBIDDEN なので
      //   ここでは Expert↔Pro 想定の文言に統一。
      const ok = confirm(
        'ダウングレードは即時反映されます。Pro 限定機能 (「なぜ?」関連理由の AI 説明など) が利用できなくなり、当月以降の API 呼出単価が切替後プランの単価に変わります。続行しますか?',
      );
      if (!ok) return;
    }

    setSubmitting(true);
    try {
      const body: Record<string, unknown> = {};
      if (planChanged) body.plan = selectedPlan;
      // PR-2 (2026-05-15) / ADR-0019 (2026-05-24): Beginner プラン時は予算上限が常に null
      //   (固定の月 50 回上限で運用、課金対象 call=project-upsert のみカウント)。
      //   UI でフォーム自体は非表示だが、防御的に Beginner では送信内容から budgetCap を除外する。
      //   さらに「Expert/Pro → Beginner」のダウングレード時 (現状仕様禁止) や、
      //   現プランが Beginner なら予算を null に強制する。
      const isBeginnerTarget = selectedPlan === 'beginner';
      const parsedBudget = isBeginnerTarget
        ? null
        : budgetUnlimited
          ? null
          : Number(budgetCap);
      if (
        (parsedBudget === null && info.monthlyBudgetCapJpy !== null) ||
        (parsedBudget !== null &&
          (info.monthlyBudgetCapJpy === null || info.monthlyBudgetCapJpy !== parsedBudget))
      ) {
        body.monthlyBudgetCapJpy = parsedBudget;
      }

      if (Object.keys(body).length === 0) {
        showError('変更内容がありません');
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
        showError(json?.error?.message ?? '更新に失敗しました');
        return;
      }
      const json = await res.json();
      if (json.data.appliedImmediately) {
        showSuccess('変更を即時反映しました');
      } else {
        // 2026-05-14: LLM プラン変更は全て即時反映に統一されたため、本ブランチは
        //   実運用では到達しない (API は appliedImmediately=true のみ返す)。
        //   万一サーバ側の挙動が変わった場合の defensive 表示として残置。
        //   PR-4 (2026-05-15): テナント TZ で日付表示。
        const date = formatDate(json.data.scheduledFor);
        showSuccess(`${date} に変更が適用されます`);
      }
      await refreshInfo();
      router.refresh();
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancelScheduled = async () => {
    if (!confirm('プラン変更予約をキャンセルしますか?')) return;
    setSubmitting(true);
    try {
      const res = await fetch('/api/tenants/me', { method: 'DELETE' });
      if (!res.ok) {
        showError('予約キャンセルに失敗しました');
        return;
      }
      showSuccess('予約をキャンセルしました');
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

  return (
    <div className="space-y-6">
      {/* ============================================================
          feat/tenant-settings-tabs (2026-05-22): 共通ヘッダー (タブ外)
          テナント識別 / 再集計ボタン / 状態系バナーはどのタブからでも
          見える必要があるため Tabs の外に配置。
          ============================================================ */}
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold">テナント設定</h1>
          <p className="text-sm text-muted-foreground">
            テナント名: {info.name}
            {info.tenantSeq != null && <span className="ml-2">(テナント #{info.tenantSeq})</span>}
          </p>
          {/* feat/settings-tenant-identity (2026-05-21): 組織 ID (slug) を独立ラベルで明示。
              ユーザのログイン入力に対応する値であり、管理者が招待時にユーザに伝える正規の識別子。 */}
          <p className="text-sm text-muted-foreground">
            組織 ID:{' '}
            <span className="font-mono" data-testid="tenant-settings-slug">
              {info.slug}
            </span>
          </p>
        </div>
        {/* 2026-05-14: 自テナント全体の再集計ボタン (画面遷移時は自動再集計済だが手動更新可) */}
        <RecalculateButton
          endpoint="/api/tenants/me/recalculate"
          label="DB 容量 / API 利用量を再集計"
          size="default"
        />
      </div>
      <p className="text-xs text-muted-foreground">
        DB 容量と API 利用量はこの画面を開いた時点で最新値を集計しています。
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
                <strong>プラン変更予約あり:</strong>{' '}
                {formatDate(
                  typeof info.scheduledPlanChangeAt === 'string'
                    ? info.scheduledPlanChangeAt
                    : info.scheduledPlanChangeAt.toISOString(),
                )} に{' '}
                <span className="font-mono">{info.scheduledNextPlan}</span> へ変更予定
              </p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="mt-2"
                onClick={handleCancelScheduled}
                disabled={submitting}
              >
                予約をキャンセル
              </Button>
            </section>
          )}

          {/* プラン変更 + 予算上限 */}
          <form onSubmit={handleSubmit} className="space-y-4">
            <section className="rounded border p-4">
              <h2 className="mb-2 font-semibold">プラン</h2>
              <p className="mb-3 text-xs text-muted-foreground">
                アップグレード・ダウングレードともに即時反映されます (Expert ↔ Pro 切替)。Beginner プランへの変更はできません。
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
                      <p className="text-xs text-muted-foreground">{p.description}</p>
                      {info.plan === p.value && (
                        <p className="mt-1 text-xs text-info">現在のプラン</p>
                      )}
                    </div>
                  </label>
                ))}
              </div>
              {beginnerSeatsExceeded && (
                <p className="mt-2 text-sm text-destructive">
                  ⚠ Beginner プランは最大 {info.beginnerMaxSeats} 席までです。現在 {info.activeUserCount} 名のため、先に席数を減らす必要があります。
                </p>
              )}
            </section>

            {/* PR-2 (2026-05-15) / ADR-0019 (2026-05-24): Beginner プランでは月次予算上限
                フォームを非表示。Beginner は固定の月 50 回上限で運用 (課金対象 call のみ) する
                ため、テナント管理者が金額の上限を設定する余地がない。Expert/Pro のみ表示。 */}
            {selectedPlan !== 'beginner' && (
              <section className="rounded border p-4">
                <h2 className="mb-2 font-semibold">月次予算上限</h2>
                <p className="mb-3 text-xs text-muted-foreground">
                  上限を超えそうな時に LLM 呼出を停止します (金額ベース)。
                </p>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={budgetUnlimited}
                    onChange={(e) => setBudgetUnlimited(e.target.checked)}
                  />
                  <span>予算上限を設定しない (無制限)</span>
                </label>
                {!budgetUnlimited && (
                  <div className="mt-2">
                    <input
                      type="number"
                      min={0}
                      value={budgetCap}
                      onChange={(e) => setBudgetCap(e.target.value)}
                      className="w-48 rounded border p-2"
                      placeholder="例: 5000"
                    />
                    <span className="ml-2 text-sm text-muted-foreground">円 / 月</span>
                  </div>
                )}
              </section>
            )}

            <Button type="submit" disabled={submitting || beginnerSeatsExceeded}>
              {submitting ? '更新中...' : '変更を保存'}
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

          {/* 2026-05-09 (PR G / #24): シードデータ参照 toggle */}
          <SeedDataToggleSection
            initialEnabled={info.seedDataEnabled}
            onUpdate={async () => {
              await refreshInfo();
            }}
          />

          {/* P-C (2026-05-08): データエクスポート */}
          <DataExportSection />

          {/* P-D (2026-05-08): データインポート */}
          <DataImportSection />

          {/* feat/settings-tenant-identity (2026-05-21): 詳細識別情報 (折りたたみ)。 */}
          <TenantIdentityDetailsSection info={info} />

          {/* テナント解約 (2026-05-08): 危険な操作なので末尾配置 + 名称一致確認 */}
          <SelfDeleteTenantSection tenantName={info.name} />
        </TabsContent>

        {/* --- 使用量タブ --- */}
        <TabsContent value="usage" className="mt-4 space-y-6">
          {/* Q5(3) (2026-05-14): 縮退モード起動中バナー + embedding 未生成件数 */}
          {degradedMode && <DegradedModeSection state={degradedMode} />}

          {/* 当月使用量 (PR-2 / 2026-05-15: plan 別タイル構成) */}
          <UsageSection
            info={info}
            budgetUsagePercent={budgetUsagePercent}
            apiReconcile={apiReconcile}
          />

          {/* Storage add-on (Phase 2 / 2026-05-08): ストレージプラン管理 */}
          {storageInitialInfo && (
            <div className="space-y-2">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="text-base font-semibold">ストレージ使用量</h2>
                <RecalculateButton
                  endpoint="/api/tenants/me/recalculate"
                  label="ストレージを再集計"
                />
              </div>
              <StorageAddonSection initialInfo={storageInitialInfo} />
            </div>
          )}
        </TabsContent>

        {/* --- 請求タブ --- */}
        <TabsContent value="billing" className="mt-4 space-y-6">
          {/* P-G (2026-05-08): 請求先情報の編集
              PR #425 (2026-05-22) ★severity-1★: paymentMethod 変更後に Client state (info) を
              即座に再取得しないと、StripePaymentMethodSection の活性条件 (info.paymentMethod) が
              古いままで「クレジットカード情報更新」ボタンが非活性となり、credit_card 払いにも
              関わらずカード登録できない = 請求漏れ発生。refreshInfo を必ず渡す。
              feat/tenant-settings-tabs (2026-05-22): タブ切替時の取りこぼし防止に onDirtyChange も渡す。 */}
          <BillingContactSection
            initialInfo={info}
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
            <h2 className="mb-2 text-lg font-semibold">請求履歴</h2>
            <p className="mb-3 text-xs text-muted-foreground">
              直近 6 ヶ月の請求金額・入金状況 (Stripe 自動引落 / 銀行振込) は別画面で確認できます。
            </p>
            <Link
              href="/settings/tenant/billing"
              className="inline-flex items-center justify-center rounded-md border bg-background px-3 py-1.5 text-sm font-medium shadow-xs hover:bg-muted/30"
            >
              📋 請求履歴を見る
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
  const reasonText =
    info.suspendReason === 'payment_delinquent'
      ? '支払いの滞納が確認されました。Stripe / 請求書のお支払い状況をご確認ください。'
      : info.suspendReason === 'tos_violation'
        ? '利用規約違反が確認されました。サポートまでお問い合わせください。'
        : '管理者による停止操作が行われています。詳細は運営サポートまでお問い合わせください。';
  return (
    <section
      data-testid="tenant-suspended-banner"
      className="rounded border border-destructive/40 bg-destructive/10 p-4 text-sm"
    >
      <p className="font-semibold text-destructive">⚠ テナント停止中 (read-only モード)</p>
      <p className="mt-1">{reasonText}</p>
      <p className="mt-2 text-xs text-muted-foreground">
        この状態では作成・更新・削除等の書き込み操作が制限されます (閲覧は可)。
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
      <summary className="cursor-pointer font-semibold">詳細情報 (サポート用)</summary>
      <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-[max-content_1fr]">
        <dt className="text-muted-foreground">テナント UUID</dt>
        <dd className="font-mono text-xs">{info.id}</dd>
        <dt className="text-muted-foreground">テナント作成日時</dt>
        <dd>{formatDateTime(createdAt)}</dd>
        <dt className="text-muted-foreground">単価 (Haiku)</dt>
        <dd>¥{info.pricePerCallHaiku}/call</dd>
        <dt className="text-muted-foreground">単価 (Sonnet)</dt>
        <dd>¥{info.pricePerCallSonnet}/call</dd>
        {cardLastVerifiedAt && (
          <>
            <dt className="text-muted-foreground">カード検証成功日時</dt>
            <dd>{formatDateTime(cardLastVerifiedAt)}</dd>
          </>
        )}
        {autoSuspendScheduledAt && (
          <>
            <dt className="text-muted-foreground">自動停止予定日時</dt>
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
  const { nullEmbeddings } = state;

  if (!state.active && nullEmbeddings.total === 0) return null;

  if (state.active) {
    // ADR-0019 (2026-05-24): Beginner 上限は課金対象 call (プロジェクト作成/更新) のみカウント。
    //   無料機能 (資産入力・チャット検索・自動インポート) は上限到達後も継続実行可能。
    const reasonText =
      state.reason === 'beginner_limit_exceeded'
        ? `Beginner プランの月間プロジェクト作成/更新上限 (${state.beginnerMonthlyCallLimit} 回) に達しました。`
        : state.reason === 'budget_exceeded'
          ? `月次予算上限 (¥${state.monthlyBudgetCapJpy?.toLocaleString() ?? '?'}) に達しました。`
          : 'API 呼び出しが停止しています。';

    return (
      <section className="rounded border border-destructive/40 bg-destructive/10 p-4 text-sm">
        <p className="font-semibold text-destructive">⚠ 縮退モード起動中</p>
        <p className="mt-1">{reasonText}</p>
        <ul className="mt-2 list-disc space-y-0.5 pl-5 text-muted-foreground">
          <li>
            プロジェクト作成・更新は停止していますが、
            <strong>各資産 (ナレッジ / リスク・課題 / 振り返り / メモ) の作成・更新</strong>と
            <strong>チャット検索</strong>は **無料・無制限**で継続できます (ADR-0019)。
          </li>
          <li>
            提案エンジンは <strong>タグ：テキスト = 5：5</strong> の縮退モード重み再配分で動作します。
          </li>
          <li>
            embedding 未生成件数:{' '}
            <strong className="text-foreground">{nullEmbeddings.total} 件</strong>{' '}
            (Project {nullEmbeddings.projects} / Knowledge {nullEmbeddings.knowledges}
            {' / '}Risk・Issue {nullEmbeddings.risksIssues} / Retrospective{' '}
            {nullEmbeddings.retrospectives})
          </li>
          <li>
            月初 (テナント TZ) に embedding 補完バッチが自動実行され、来月分の枠で順次生成されます。
            {state.reason === 'budget_exceeded' &&
              '月次予算上限の引き上げで即時復活できます。'}
            {state.reason === 'beginner_limit_exceeded' &&
              ' Expert / Pro プランへのアップグレードで即時復活できます。'}
          </li>
        </ul>
      </section>
    );
  }

  // 縮退中ではないが、過去の縮退で残った未生成件数がある場合
  return (
    <section className="rounded border border-amber-300 bg-amber-50 p-4 text-sm dark:bg-amber-900/30">
      <p className="font-semibold">
        ℹ embedding 未生成のデータが <strong>{nullEmbeddings.total} 件</strong> あります
      </p>
      <p className="mt-1 text-muted-foreground">
        Project {nullEmbeddings.projects} / Knowledge {nullEmbeddings.knowledges}{' '}
        / Risk・Issue {nullEmbeddings.risksIssues} / Retrospective{' '}
        {nullEmbeddings.retrospectives}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        これらは月初 (テナント TZ) のバッチで自動補完されます。補完は当月の API 利用枠を消費します。
      </p>
    </section>
  );
}

function UsageSection({
  info,
  budgetUsagePercent,
  apiReconcile,
}: {
  info: TenantSelfInfo;
  budgetUsagePercent: number | null;
  /** 2026-05-14: ApiCallLog SUM との drift 結果。整合性検証用 */
  apiReconcile: ApiUsageReconcileResult | null;
}) {
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

  return (
    <section
      className="rounded border p-4"
      title="本テナントの当月使用量。月初 (テナント TZ) にリセット"
    >
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-semibold">
          当月使用量
          <UsageDriftBadge reconcile={apiReconcile} />
        </h2>
        <div className="flex items-center gap-2">
          <RecalculateButton
            endpoint="/api/tenants/me/recalculate"
            label="API 利用量を再集計"
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
          title="当月の LLM/Embedding 呼出回数 (ApiCallLog 集計 = 請求書根拠と同じ真値)"
        >
          <p className="text-xs text-muted-foreground">API 呼出</p>
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
            title="Beginner プランはプロジェクト作成/更新が月 50 回まで無料です (ADR-0019)。資産入力・チャット検索は無料・無制限。残数が 0 になると当月はプロジェクト作成/更新が停止します"
          >
            <p className="text-xs text-muted-foreground">月次API呼出 残数</p>
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
              <span className="ml-1 text-sm font-normal text-muted-foreground">回</span>
            </p>
          </div>
        ) : (
          <>
            <div
              className="cursor-help"
              title="当月の内部請求額 (ApiCallLog 集計 = 請求書根拠と同じ真値)。Expert ¥10/call / Pro ¥15/call の固定単価で計算 (ADR-0019 / 2026-05-24 改定後)。課金対象はプロジェクト作成/更新 + なぜ機能 (Pro のみ)。資産入力・チャット検索・自動インポートは無料"
            >
              <p className="text-xs text-muted-foreground">API 費用</p>
              <p className="text-xl font-bold">
                ¥{displayCostJpy.toLocaleString()}
              </p>
            </div>
            <div
              className="cursor-help"
              title="自分で設定した月次予算上限。超過時は LLM 呼び出しが自動ブロックされる"
            >
              <p className="text-xs text-muted-foreground">月次予算上限</p>
              <p className="text-xl font-bold">
                {info.monthlyBudgetCapJpy != null
                  ? `¥${info.monthlyBudgetCapJpy.toLocaleString()}`
                  : '無制限'}
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
          <p className="mt-1 text-xs text-muted-foreground">予算消化率: {budgetUsagePercent}%</p>
        </div>
      )}
    </section>
  );
}

// ================================================================
// テナント解約セクション (2026-05-08)
// ================================================================

function SelfDeleteTenantSection({ tenantName }: { tenantName: string }) {
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
      setError('入力されたテナント名が一致しません');
      return;
    }
    const ok = confirm(
      `本当にテナント「${tenantName}」を解約しますか?\n\n` +
        '解約後は全ユーザーがログイン不可となり、業務データへのアクセスができなくなります。' +
        '解約から 90 日経過すると業務データは物理削除されます (= 復元不可)。\n\n' +
        '※ 解約前にデータエクスポートを実施することを強く推奨します。',
    );
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
        const msg = json?.error?.message ?? '解約に失敗しました';
        setError(msg);
        showError(msg);
        return;
      }
      showSuccess('テナントを解約しました。ログアウトしています...');
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
        ⚠ テナント解約 (危険な操作) — クリックで展開
      </summary>
      <div className="space-y-3 p-4">
        <p className="text-sm text-muted-foreground">
          本テナントを解約します。解約後は全ユーザーがログイン不可となり、業務データへのアクセスができなくなります。
        </p>
        <ul className="ml-4 list-disc text-xs text-muted-foreground">
          <li>解約直後: テナント本体 + 配下の業務データ (プロジェクト/ナレッジ/課題等) を **論理削除**</li>
          <li>90 日経過後: 業務データを **物理削除** (= 復元不可、データ容量解放)</li>
          <li>監査ログ・課金根拠データ (api_call_logs / 月次履歴) は保持</li>
          <li>解約前に <a href="#" className="text-info underline">データエクスポート</a> 実施を強く推奨</li>
        </ul>

        <form onSubmit={handleSubmit} className="mt-3 space-y-2">
          <label className="block text-sm font-medium">
            確認のため、現在のテナント名「<span className="font-mono">{tenantName}</span>」を正確に入力してください
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
            {submitting ? '解約処理中...' : '🗑 テナントを解約する'}
          </Button>
        </form>
      </div>
    </details>
  );
}

// ================================================================
// Storage add-on (Phase 2 / 2026-05-08): ストレージプラン管理セクション
// ================================================================

const STORAGE_ADDON_OPTIONS: Array<{
  value: StorageInitialInfo['storageAddonPlan'];
  label: string;
  desc: string;
}> = [
  { value: 'standard', label: 'Standard', desc: 'LLM プランに連動した無料容量' },
  { value: 'plus', label: 'Storage Plus', desc: '+200MB / +¥500/月' },
  { value: 'pro_storage', label: 'Storage Pro', desc: '+1GB / +¥1,500/月' },
  { value: 'enterprise', label: 'Storage Enterprise', desc: '+5GB / +¥5,000/月' },
];

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${bytes} B`;
}

function StorageAddonSection({ initialInfo }: { initialInfo: StorageInitialInfo }) {
  const router = useRouter();
  const { showSuccess, showError } = useToast();
  // PR-4 (2026-05-15): テナント TZ で日付を表示
  const { formatDate } = useFormatters();
  const [info, setInfo] = useState(initialInfo);
  const [selected, setSelected] = useState(initialInfo.storageAddonPlan);
  const [submitting, setSubmitting] = useState(false);

  const usagePercent = Math.min(100, Math.round(info.usageRatio * 100));
  const isOverLimit = info.usageRatio > 1.0;
  const planChanged = selected !== info.storageAddonPlan;

  const ADDON_ORDER = { standard: 0, plus: 1, pro_storage: 2, enterprise: 3 } as const;
  const isDowngrade = ADDON_ORDER[selected] < ADDON_ORDER[info.storageAddonPlan];

  const refresh = async () => {
    const res = await fetch('/api/tenants/me/storage-addon');
    if (!res.ok) return;
    const json = await res.json();
    if (json?.data) {
      // graceStartedAt 等が Date のままなので、文字列化された response で上書き
      setInfo({
        ...json.data,
        graceStartedAt: json.data.graceStartedAt
          ? new Date(json.data.graceStartedAt).toISOString()
          : null,
        scheduledStorageAddonAt: json.data.scheduledStorageAddonAt
          ? new Date(json.data.scheduledStorageAddonAt).toISOString()
          : null,
        storageBytesUsedAt: json.data.storageBytesUsedAt
          ? new Date(json.data.storageBytesUsedAt).toISOString()
          : null,
      });
      setSelected(json.data.storageAddonPlan);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!planChanged) {
      showError('変更内容がありません');
      return;
    }
    if (isDowngrade) {
      const ok = confirm(
        'ダウングレードは翌月 1 日 (UTC) から適用されます。当月分の月額は引き続き発生します。続行しますか?',
      );
      if (!ok) return;
    }
    setSubmitting(true);
    try {
      const res = await fetch('/api/tenants/me/storage-addon', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan: selected }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        showError(json?.error?.message ?? 'プラン変更に失敗しました');
        return;
      }
      if (json.data.appliedImmediately) {
        showSuccess('ストレージプランを即時反映しました');
      } else {
        // PR-4 (2026-05-15): テナント TZ で日付表示
        const date = formatDate(json.data.scheduledFor);
        showSuccess(`${date} にストレージプランを変更します`);
      }
      await refresh();
      router.refresh();
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancelScheduled = async () => {
    if (!confirm('ストレージプラン変更予約をキャンセルしますか?')) return;
    setSubmitting(true);
    try {
      const res = await fetch('/api/tenants/me/storage-addon', { method: 'DELETE' });
      if (!res.ok) {
        showError('予約キャンセルに失敗しました');
        return;
      }
      showSuccess('予約をキャンセルしました');
      await refresh();
      router.refresh();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="rounded border p-4">
      <h2 className="mb-2 font-semibold">ストレージプラン (容量 add-on)</h2>
      <p className="mb-3 text-xs text-muted-foreground">
        LLM プランと独立した容量プランです。アップグレードは即時反映、ダウングレードは翌月 1 日 UTC に適用されます。
      </p>

      {/* 当月使用量 */}
      <div className="mb-3 rounded bg-muted/30 p-3 text-sm">
        <div className="flex justify-between">
          <span>当月使用量</span>
          <span className={isOverLimit ? 'font-bold text-destructive' : 'font-bold'}>
            {formatBytes(info.storageBytesUsed)} / {formatBytes(info.storageLimitBytes)}
          </span>
        </div>
        <div className="mt-2 h-2 w-full overflow-hidden rounded bg-muted">
          <div
            className={`h-full ${
              isOverLimit
                ? 'bg-destructive'
                : usagePercent >= 80
                  ? 'bg-amber-500'
                  : 'bg-info'
            }`}
            style={{ width: `${Math.min(100, usagePercent)}%` }}
          />
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          使用率 {usagePercent}% (キャッシュ値、最終更新: {info.storageBytesUsedAt ?? '未計測'})
        </p>
      </div>

      {/* Grace period 警告 */}
      {info.graceState === 'grace_active' && (
        <div className="mb-3 rounded border border-amber-300 bg-amber-50 p-3 text-sm dark:bg-amber-900/30">
          <p className="font-semibold">⚠ ストレージ上限超過中 (Grace period)</p>
          <p>
            残り {info.graceDaysRemaining} 日以内にデータ削除またはプランアップグレードが必要です。
            7 日経過すると書き込み操作が停止します。
          </p>
        </div>
      )}
      {info.graceState === 'write_blocked' && (
        <div className="mb-3 rounded border border-destructive bg-destructive/10 p-3 text-sm">
          <p className="font-semibold text-destructive">🚨 書き込み停止中</p>
          <p>
            ストレージ上限超過状態が 7 日以上続いたため、書き込み操作が停止しています。
            データを削除して上限内に戻すか、Storage プランをアップグレードしてください。
          </p>
        </div>
      )}

      {/* 予約済プラン変更 (PR-4: テナント TZ で日付表示) */}
      {info.scheduledStorageAddonAt && info.scheduledNextStorageAddon && (
        <div className="mb-3 rounded border border-amber-300 bg-amber-50 p-3 text-sm dark:bg-amber-900/30">
          <p>
            <strong>ストレージプラン変更予約あり:</strong>{' '}
            {formatDate(info.scheduledStorageAddonAt)} に{' '}
            <span className="font-mono">{info.scheduledNextStorageAddon}</span> へ変更予定
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="mt-2"
            onClick={handleCancelScheduled}
            disabled={submitting}
          >
            予約をキャンセル
          </Button>
        </div>
      )}

      {/* プラン選択 */}
      <form onSubmit={handleSubmit} className="space-y-2">
        {STORAGE_ADDON_OPTIONS.map((opt) => (
          <label
            key={opt.value}
            className="flex cursor-pointer items-start gap-2 rounded border p-3 hover:bg-muted/30"
          >
            <input
              type="radio"
              name="storageAddonPlan"
              value={opt.value}
              checked={selected === opt.value}
              onChange={() => setSelected(opt.value)}
              className="mt-1"
            />
            <div>
              <p className="font-medium">{opt.label}</p>
              <p className="text-xs text-muted-foreground">{opt.desc}</p>
              {info.storageAddonPlan === opt.value && (
                <p className="mt-1 text-xs text-info">現在のプラン</p>
              )}
            </div>
          </label>
        ))}

        <Button type="submit" disabled={submitting || !planChanged}>
          {submitting ? '更新中...' : 'ストレージプランを変更'}
        </Button>
      </form>
    </section>
  );
}

// ================================================================
// P-C (2026-05-08): データエクスポートセクション
// ================================================================

function DataExportSection() {
  return (
    <section className="mt-8 space-y-3 rounded border p-4">
      <h2 className="text-lg font-semibold">データエクスポート</h2>
      <p className="text-sm text-muted-foreground">
        本テナントの全業務データ (プロジェクト / ナレッジ / 課題 / 振り返り / メモ /
        顧客 / ステークホルダー等) を ZIP ファイルでダウンロードします。
      </p>
      <ul className="ml-4 list-disc text-xs text-muted-foreground">
        <li>JSON 形式 (構造化データ、再 import 可能な完全な情報)</li>
        <li>CSV 形式併載 (主要 5 種別、Excel での閲覧用)</li>
        <li>添付ファイル: URL のみ含まれます (実ファイルは外部ストレージから別途取得してください)</li>
        <li>パスワードハッシュ・MFA 秘密鍵等の認証情報は除外されています</li>
      </ul>
      <a
        href="/api/tenants/me/export"
        className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-xs hover:bg-primary/90"
        download
      >
        📦 全データを ZIP でダウンロード
      </a>
    </section>
  );
}

// ================================================================
// P-D (2026-05-08): データインポートセクション
// ================================================================

function DataImportSection() {
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
      setError('ZIP ファイルを選択してください');
      return;
    }
    if (!file.name.toLowerCase().endsWith('.zip')) {
      setError('拡張子が .zip のファイルを選択してください');
      return;
    }
    const ok = confirm(
      'インポートしたデータは全件「新規作成」されます (既存データは変更されません)。続行しますか?',
    );
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
        const message = json?.error?.message ?? 'インポートに失敗しました';
        setError(message);
        showError(message);
        return;
      }
      setResultSummary({
        importedAt: json.summary.importedAt,
        counts: json.summary.counts,
      });
      showSuccess('データを取り込みました');
      router.refresh();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="mt-8 space-y-3 rounded border p-4">
      <h2 className="text-lg font-semibold">データインポート (バックアップ復元 / テナント間移行用)</h2>
      <p className="text-sm text-muted-foreground">
        <strong>本機能は本サービスから出力した ZIP の取込専用です。</strong>
        データエクスポート機能で出力した ZIP をアップロードして取り込みます。
      </p>
      <div className="rounded bg-muted/40 p-3 text-xs text-muted-foreground">
        <p className="font-semibold text-foreground">想定する利用シーン</p>
        <ul className="ml-4 mt-1 list-disc">
          <li>退会前にエクスポートしたデータを別テナント (社内分社化など) に取り込む</li>
          <li>誤削除・障害時のバックアップ復元</li>
          <li>本番テナントの一部を検証用テナントに同期する</li>
        </ul>
        <p className="mt-2 font-semibold text-foreground">対象外の利用シーン</p>
        <ul className="ml-4 mt-1 list-disc">
          <li>外部システム (社内 wiki / Excel / 旧プロジェクト管理ツール) からの初回データ移行
            <br />→ 独自フォーマットの取込は本機能では受け付けません (誤データ混入防止のため)</li>
        </ul>
      </div>
      <ul className="ml-4 list-disc text-xs text-muted-foreground">
        <li>受付フォーマット: 本サービスのデータエクスポート ZIP のみ (それ以外は拒否)</li>
        <li>動作: 全件「新規作成」(既存データの上書き / マージはしません)</li>
        <li>ユーザ: 同じメールアドレスの既存ユーザがいる場合は既存に再マップ。新規ユーザは初回ログイン時にパスワード再設定が必要</li>
        <li>Beginner プランでは合計 5 席を超えるインポートを拒否</li>
        <li>同テナントで他のインポートが進行中の場合は受付不可</li>
      </ul>

      <div className="mt-3 rounded border-l-4 border-info bg-info/5 p-3 text-xs">
        <p className="font-semibold">外部システム (Excel / 旧 PM ツール 等) から初回データを取り込みたい場合</p>
        <p className="mt-1 text-muted-foreground">
          本機能ではなく <a href="/settings/tenant/external-import" className="text-info underline">外部データ移行ウィザード</a> をご利用ください。CSV ファイル (UTF-8) をアップロード → カラムをマッピング → プレビュー → 取込 の 4 ステップでナレッジ + 過去課題を取り込めます。Excel をお使いの場合は「名前を付けて保存」→「CSV (UTF-8)」で変換してください。
        </p>
      </div>

      <form onSubmit={handleSubmit} className="mt-3 space-y-3">
        <div>
          <label htmlFor="import-zip" className="text-sm font-medium">
            ZIP ファイル
          </label>
          <input
            id="import-zip"
            type="file"
            accept=".zip,application/zip"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="mt-1 block w-full text-sm"
            disabled={submitting}
          />
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button type="submit" disabled={submitting || !file}>
          {submitting ? '取込中...' : '📥 取り込みを実行'}
        </Button>
      </form>

      {resultSummary && (
        <div className="mt-3 rounded bg-muted/50 p-3 text-xs">
          <p className="font-semibold">取込完了 ({resultSummary.importedAt})</p>
          <ul className="ml-4 list-disc">
            <li>プロジェクト: {resultSummary.counts.projects}</li>
            <li>タスク: {resultSummary.counts.tasks}</li>
            <li>ナレッジ: {resultSummary.counts.knowledge}</li>
            <li>リスク/課題: {resultSummary.counts.risksIssues}</li>
            <li>振り返り: {resultSummary.counts.retrospectives}</li>
            <li>メモ: {resultSummary.counts.memos}</li>
            <li>顧客: {resultSummary.counts.customers}</li>
            <li>ユーザ (新規作成): {resultSummary.counts.usersCreated}</li>
            <li>ユーザ (既存に再マップ): {resultSummary.counts.usersMerged}</li>
          </ul>
        </div>
      )}
    </section>
  );
}

// ================================================================
// 2026-05-09 (PR G / #24): シードデータ参照 toggle セクション
// ================================================================

function SeedDataToggleSection({
  initialEnabled,
  onUpdate,
}: {
  initialEnabled: boolean;
  onUpdate: () => Promise<void>;
}) {
  const { showSuccess, showError } = useToast();
  const [enabled, setEnabled] = useState(initialEnabled);
  const [submitting, setSubmitting] = useState(false);

  async function handleToggle(next: boolean) {
    setSubmitting(true);
    try {
      const res = await fetch('/api/tenants/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seedDataEnabled: next }),
      });
      if (!res.ok) {
        showError('シードデータ参照の切替に失敗しました');
        return;
      }
      setEnabled(next);
      showSuccess(next ? 'シードデータ参照を有効化しました' : 'シードデータ参照を無効化しました');
      await onUpdate();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="mt-8 rounded border p-4">
      <h2 className="text-lg font-semibold">提案エンジン: シードデータ参照</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        プラットフォーム運営者が用意した <strong>サンプルナレッジ・サンプル過去案件</strong> を、
        提案エンジンの候補に含めるかを切替えます。契約直後でデータが少ない時期にサンプルから
        雛形採用するのに有効ですが、業務固有の文脈に集中したい場合は無効化してください。
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        ※ <strong>テナント分離 (Phase 2 完了)</strong> により、他テナント (他顧客) のデータは
        本トグル設定に関わらず一切参照されません。本トグルは「管理テナントのシードデータ参照」のみを制御します。
      </p>
      <div className="mt-3 flex items-center gap-3">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={enabled}
            disabled={submitting}
            onChange={(e) => handleToggle(e.target.checked)}
          />
          シードデータを提案候補に含める (default: 有効)
        </label>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        現在: <strong>{enabled ? '有効 (自テナント + 管理テナントのシード)' : '無効 (自テナントのみ)'}</strong>
      </p>
    </section>
  );
}

// ================================================================
// P-G: 請求先情報の編集セクション
// ================================================================

function BillingContactSection({
  initialInfo,
  onUpdate,
  onDirtyChange,
}: {
  initialInfo: TenantSelfInfo;
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
        if (code === 'VALIDATION_ERROR') setError(message ?? '入力内容に誤りがあります');
        else if (code === 'CREDIT_CARD_NOT_REGISTERED') {
          setError(
            message ??
              'クレジットカードが未登録です。「請求先情報を更新」を押すと自動でカード登録画面に進みます。',
          );
        } else setError(message ?? '更新に失敗しました');
        showError('請求先情報の更新に失敗しました');
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
          showSuccess('過去に登録したクレジットカードで自動引落契約を作成しました');
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
          showError(setupJson?.error?.message ?? 'カード登録画面の起動に失敗しました');
          // paymentMethod は DB 上 invoice のままなので状態は壊れていない
          await onUpdate();
          router.refresh();
          return;
        }
        // 住所等は既に保存済みである旨を伝えてから遷移
        showSuccess('請求先情報を保存しました。続けてカード登録画面に移動します');
        // feat/tenant-settings-tabs (2026-05-22): Stripe 遷移直前で baseline を更新しておく。
        //   万一遷移が阻まれた場合 (browser dialog cancel など) でも dirty 扱いを残さない。
        baselineFormRef.current = form;
        onDirtyChange?.(false);
        window.location.href = setupJson.data.checkoutUrl;
        return;
      }

      showSuccess('請求先情報を更新しました');
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
      <h2 className="text-lg font-semibold">請求先情報</h2>
      <p className="text-xs text-muted-foreground">
        請求書の発行先・送付先として使用される情報です。super_admin (運営者) が請求業務で参照します。
      </p>

      {error && (
        <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>
      )}

      {/* 2026-05-09 (PR C / #5): 個人 / 法人 切替 */}
      <div className="space-y-2">
        <span className="text-sm font-medium">請求先種別 *</span>
        <div className="flex gap-4 text-sm">
          <label className="flex items-center gap-1.5">
            <input
              type="radio"
              name="billingType"
              value="corporate"
              checked={form.billingType === 'corporate'}
              onChange={() => setForm({ ...form, billingType: 'corporate' })}
            />
            法人
          </label>
          <label className="flex items-center gap-1.5">
            <input
              type="radio"
              name="billingType"
              value="individual"
              checked={form.billingType === 'individual'}
              onChange={() => setForm({ ...form, billingType: 'individual', billingCompanyName: '' })}
            />
            個人
          </label>
        </div>
      </div>

      {form.billingType === 'corporate' && (
        <div className="space-y-2">
          <label htmlFor="billingCompanyName" className="text-sm font-medium">会社名 / 法人名 *</label>
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
          {form.billingType === 'corporate' ? '請求担当者名 *' : 'お名前 *'}
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
        <label htmlFor="billingContactEmail" className="text-sm font-medium">請求先メール *</label>
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
        <label htmlFor="billingPostalCode" className="text-sm font-medium">郵便番号 *</label>
        <input
          id="billingPostalCode"
          className="w-full rounded border p-2 text-sm"
          value={form.billingPostalCode}
          onChange={(e) => setForm({ ...form, billingPostalCode: e.target.value })}
          maxLength={10}
          placeholder="例: 100-0001"
          pattern="\d{3}-?\d{4}"
          required
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-2">
          <label htmlFor="billingPrefecture" className="text-sm font-medium">都道府県 *</label>
          <input
            id="billingPrefecture"
            className="w-full rounded border p-2 text-sm"
            value={form.billingPrefecture}
            onChange={(e) => setForm({ ...form, billingPrefecture: e.target.value })}
            maxLength={20}
            placeholder="例: 東京都"
            required
          />
        </div>
        <div className="space-y-2">
          <label htmlFor="billingCity" className="text-sm font-medium">市区町村 *</label>
          <input
            id="billingCity"
            className="w-full rounded border p-2 text-sm"
            value={form.billingCity}
            onChange={(e) => setForm({ ...form, billingCity: e.target.value })}
            maxLength={100}
            placeholder="例: 千代田区"
            required
          />
        </div>
      </div>
      <div className="space-y-2">
        <label htmlFor="billingStreetAddress" className="text-sm font-medium">番地・町名 *</label>
        <input
          id="billingStreetAddress"
          className="w-full rounded border p-2 text-sm"
          value={form.billingStreetAddress}
          onChange={(e) => setForm({ ...form, billingStreetAddress: e.target.value })}
          maxLength={200}
          placeholder="例: 千代田1-1"
          required
        />
      </div>
      {/* 2026-05-09 (#10): 任意 */}
      <div className="space-y-2">
        <label htmlFor="billingBuildingName" className="text-sm font-medium">建物名・部屋番号 (任意)</label>
        <input
          id="billingBuildingName"
          className="w-full rounded border p-2 text-sm"
          value={form.billingBuildingName}
          onChange={(e) => setForm({ ...form, billingBuildingName: e.target.value })}
          maxLength={200}
          placeholder="例: 〇〇ビル 5F"
        />
      </div>

      {/* 2026-05-09 (PR C): legacy billingAddress が残っている場合は read-only で表示 (データ損失防止) */}
      {initialInfo.billingAddress
        && !initialInfo.billingPostalCode
        && !initialInfo.billingPrefecture && (
        <div className="rounded border border-amber-300 bg-amber-50 p-3 text-xs dark:bg-amber-900/30">
          <strong>過去登録された住所 (旧形式):</strong>
          <pre className="mt-1 whitespace-pre-wrap font-mono text-xs">{initialInfo.billingAddress}</pre>
          <p className="mt-1">
            上記サブフィールドに分割入力 + 保存すると、旧形式は新形式で上書きされます。
          </p>
        </div>
      )}

      <div className="space-y-2">
        <label htmlFor="billingPhoneNumber" className="text-sm font-medium">電話番号 (任意)</label>
        <input
          id="billingPhoneNumber"
          className="w-full rounded border p-2 text-sm"
          value={form.billingPhoneNumber}
          onChange={(e) => setForm({ ...form, billingPhoneNumber: e.target.value })}
          maxLength={20}
          placeholder="例: 03-1234-5678"
        />
      </div>

      <div className="space-y-2">
        <label htmlFor="paymentMethod" className="text-sm font-medium">支払い方法 *</label>
        <select
          id="paymentMethod"
          className="w-full rounded border bg-background p-2 text-sm"
          value={form.paymentMethod}
          onChange={(e) => setForm({ ...form, paymentMethod: e.target.value })}
        >
          {/* 2026-05-15: 旧 'invoice'（請求書送付）と 'bank_transfer'（銀行振込）を「銀行振込」に統合 (内部値 'invoice')。
              ユーザから見て同じ運用フローのため 1 選択肢に集約。旧 bank_transfer レコードは初期化時に invoice 正規化。 */}
          <option value="invoice">銀行振込</option>
          {/* PR #425 (2026-05-21): クレジットカード払いを正式対応。選択 + 保存で paymentMethod が
              credit_card に切り替わり、下部「クレジットカード情報更新」ボタンが活性化される。
              credit_card → invoice 戻しは server 側で Stripe Subscription を即時 cancel。 */}
          <option value="credit_card">クレジットカード</option>
        </select>
      </div>

      <Button type="submit" disabled={submitting}>
        {submitting ? '更新中...' : '請求先情報を更新'}
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
  if (info.plan !== 'beginner') return null;

  const days = info.beginnerDaysRemaining ?? 0;

  if (info.beginnerExpiryState === 'expired') {
    return (
      <section className="space-y-2 rounded border border-destructive/30 bg-destructive/10 p-4">
        <h2 className="text-base font-semibold text-destructive">
          🔴 Beginner プラン期限切れ — 読み取り専用モード
        </h2>
        <p className="text-sm">
          Beginner プランの試用期間 (90 日) が経過したため、ご利用テナントは <strong>読み取り専用モード</strong> に移行しました。
        </p>
        <ul className="ml-4 list-disc text-sm text-muted-foreground">
          <li>データの作成・更新・削除はできません</li>
          <li>ログインと既存データの閲覧は引き続き可能です</li>
          <li>
            <strong>データのエクスポートは引き続きご利用いただけます</strong> (下記「データエクスポート」セクションからダウンロード可)
          </li>
        </ul>
        <p className="text-sm">
          書き込み機能を再開するには下記の「プラン変更」セクションから <strong>Expert または Pro プラン</strong> へのアップグレードをお願いします。
        </p>
      </section>
    );
  }

  if (info.beginnerExpiryState === 'warning_75') {
    return (
      <section className="space-y-2 rounded border border-orange-400 bg-orange-50 p-4 dark:border-orange-900/40 dark:bg-orange-950/30">
        <h2 className="text-base font-semibold text-orange-900 dark:text-orange-200">
          🟠 Beginner プラン期限まで残り {days} 日 (重要)
        </h2>
        <p className="text-sm text-orange-900 dark:text-orange-200">
          期限超過後は <strong>読み取り専用モード</strong> に移行します (データの作成・更新・削除はできなくなります)。
          引き続きアクティブにご利用いただく場合は下記の「プラン変更」セクションで Expert / Pro プランへのアップグレードをご検討ください。
          なお、データエクスポート機能は期限後も引き続きご利用可能です。
        </p>
      </section>
    );
  }

  if (info.beginnerExpiryState === 'warning_60') {
    return (
      <section className="space-y-2 rounded border border-amber-400 bg-amber-50 p-4 dark:border-amber-900/40 dark:bg-amber-950/30">
        <h2 className="text-base font-semibold text-amber-900 dark:text-amber-200">
          🟡 Beginner プラン期限まで残り {days} 日
        </h2>
        <p className="text-sm text-amber-900 dark:text-amber-200">
          Beginner プランは初回テナント作成から 90 日限定の試用プランです。期限超過後は読み取り専用モードに移行します (データのエクスポート機能は期限後も継続利用可能)。
          引き続きアクティブにご利用の場合は下記の「プラン変更」セクションで Expert / Pro プランへのアップグレードをご検討ください。
        </p>
      </section>
    );
  }

  // active (Day 0〜59): 控えめに「試用中」を案内
  return (
    <section className="space-y-1 rounded border border-info/30 bg-info/5 p-3">
      <p className="text-sm">
        <strong>Beginner プラン (90 日試用) ご利用中</strong> — 残り {days} 日。
      </p>
      <p className="text-xs text-muted-foreground">
        試用期間終了後は読み取り専用モードに移行します。引き続きご利用の場合は Expert / Pro プランへのアップグレードをお願いします。
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
      showError('変更内容がありません');
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
        showError(json?.error?.message ?? '言語・タイムゾーン設定の保存に失敗しました');
        return;
      }
      // fix/jwt-resign-for-netlify (2026-05-18):
      //   旧仕様は ここで useSession().update() を呼んで JWT を更新していたが、
      //   NextAuth v5 + @netlify/plugin-nextjs で Set-Cookie が反映されない事象あり。
      //   現在は API ルート側 (`/api/tenants/me/i18n`) が再署名 + Set-Cookie 済なので
      //   クライアントは router.refresh() で SSR 経由の即時反映に依存する。
      showSuccess('言語・タイムゾーン設定を保存しました');
      await onUpdate();
      router.refresh();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="mt-8 rounded border p-4">
      <h2 className="mb-2 text-lg font-semibold">言語・タイムゾーン</h2>
      <p className="mb-3 text-xs text-muted-foreground">
        テナント全体に適用される表示言語・タイムゾーンです。配下の全ユーザの画面表示・
        Beginner 残日数・月初リセット境界などはこの設定に従います。
      </p>
      <form onSubmit={handleSubmit} className="space-y-3">
        <div className="space-y-1">
          <label htmlFor="tenant-i18n-locale" className="text-sm font-medium">
            言語
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
                  {label} ({key}){!selectable ? ' — 翻訳準備中' : ''}
                </option>
              );
            })}
          </select>
        </div>
        <div className="space-y-1">
          <label htmlFor="tenant-i18n-tz" className="text-sm font-medium">
            タイムゾーン
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
          {submitting ? '更新中...' : '保存'}
        </Button>
      </form>
    </section>
  );
}
