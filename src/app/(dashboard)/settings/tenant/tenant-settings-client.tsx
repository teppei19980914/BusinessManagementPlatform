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

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/toast-provider';
import { SUPPORTED_LOCALES, SELECTABLE_LOCALES } from '@/config';
// PR-4 (2026-05-15): テナント TZ で日付を表示
import { useFormatters } from '@/lib/use-formatters';
// 2026-05-14: 自テナント DB 容量 + API 利用量の再集計ボタン + drift 警告
import { RecalculateButton } from '@/components/recalculate-button';
import { UsageDriftBadge } from '@/components/usage-drift-badge';
import type { ApiUsageReconcileResult } from '@/services/api-usage-recalc.service';
// Q5(3) (2026-05-14): 縮退モード状態 (Server Component で取得した snapshot を受け取る)
import type { DegradedModeState } from '@/services/degraded-mode.service';

type TenantSelfInfo = {
  id: string;
  tenantSeq: number | null;
  name: string;
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
};

type PlanLabel = { value: 'beginner' | 'expert' | 'pro'; label: string; description: string };

const PLAN_OPTIONS: PlanLabel[] = [
  {
    value: 'beginner',
    label: 'Beginner',
    description: '月間 100 回上限・最大 5 席・無料',
  },
  {
    value: 'expert',
    label: 'Expert',
    description: '無制限従量課金 (¥10/call)',
  },
  {
    value: 'pro',
    label: 'Pro',
    description: '無制限従量課金 (¥30/call)・Claude Sonnet',
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
}: {
  initialInfo: TenantSelfInfo;
  storageInitialInfo: StorageInitialInfo | null;
  /** 2026-05-14: 自テナントの API 利用量整合性チェック結果 (drift 警告用) */
  apiReconcile: ApiUsageReconcileResult | null;
  /** Q5(3) (2026-05-14): 縮退モード状態 + embedding 未生成件数 (取得失敗時は null) */
  degradedMode: DegradedModeState | null;
}) {
  // PR-4 (2026-05-15): テナント TZ で日付を表示するため useFormatters を導入
  const { formatDate } = useFormatters();
  const router = useRouter();
  const { showSuccess, showError } = useToast();
  const [info, setInfo] = useState(initialInfo);
  const [selectedPlan, setSelectedPlan] = useState(initialInfo.plan);
  const [budgetCap, setBudgetCap] = useState<string>(
    initialInfo.monthlyBudgetCapJpy != null ? String(initialInfo.monthlyBudgetCapJpy) : '',
  );
  const [budgetUnlimited, setBudgetUnlimited] = useState(initialInfo.monthlyBudgetCapJpy == null);
  const [submitting, setSubmitting] = useState(false);

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
      // PR-2 (2026-05-15): Beginner プラン時は予算上限が常に null (固定の月 100 回上限で運用)。
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
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold">テナント設定</h1>
          <p className="text-sm text-muted-foreground">
            テナント名: {info.name}
            {info.tenantSeq != null && <span className="ml-2">(テナント #{info.tenantSeq})</span>}
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

      {/* P-B (2026-05-08): Beginner プラン期限バナー */}
      <BeginnerExpiryBanner info={info} />

      {/* Q5(3) (2026-05-14): 縮退モード起動中バナー + embedding 未生成件数 */}
      {degradedMode && <DegradedModeSection state={degradedMode} />}

      {/* 当月使用量 (PR-2 / 2026-05-15: plan 別タイル構成に切替) */}
      <UsageSection
        info={info}
        budgetUsagePercent={budgetUsagePercent}
        apiReconcile={apiReconcile}
      />

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
            {PLAN_OPTIONS.map((p) => (
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

        {/* PR-2 (2026-05-15): Beginner プランでは月次予算上限フォームを非表示。
            Beginner は固定の月 100 回上限で運用するため、テナント管理者が金額の上限を
            設定する余地がない。Expert/Pro のみ表示。 */}
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

      {/* 2026-05-09 (PR G / #24): シードデータ参照 toggle */}
      <SeedDataToggleSection
        initialEnabled={info.seedDataEnabled}
        onUpdate={async () => {
          await refreshInfo();
        }}
      />

      {/* P-G (2026-05-08): 請求先情報の編集 */}
      <BillingContactSection initialInfo={info} />

      {/* P-C (2026-05-08): データエクスポート */}
      <DataExportSection />

      {/* P-D (2026-05-08): データインポート */}
      <DataImportSection />

      {/* テナント解約 (2026-05-08): 危険な操作なので末尾配置 + 名称一致確認 */}
      <SelfDeleteTenantSection tenantName={info.name} />
    </div>
  );
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
    const reasonText =
      state.reason === 'beginner_limit_exceeded'
        ? `Beginner プランの月間 API 呼び出し上限 (${state.beginnerMonthlyCallLimit} 回) に達しました。`
        : state.reason === 'budget_exceeded'
          ? `月次予算上限 (¥${state.monthlyBudgetCapJpy?.toLocaleString() ?? '?'}) に達しました。`
          : 'API 呼び出しが停止しています。';

    return (
      <section className="rounded border border-destructive/40 bg-destructive/10 p-4 text-sm">
        <p className="font-semibold text-destructive">⚠ 縮退モード起動中</p>
        <p className="mt-1">{reasonText}</p>
        <ul className="mt-2 list-disc space-y-0.5 pl-5 text-muted-foreground">
          <li>
            プロジェクト / ナレッジ / リスク・課題 / 振り返りの新規作成・更新は引き続き行えます
            (embedding 生成のみ停止)。
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
  // Beginner プラン残数 (= 上限 - 当月既呼出)。負数にしないため Math.max(0, ...) で clamp。
  const beginnerCallsRemaining = Math.max(
    0,
    info.beginnerMonthlyCallLimit - info.currentMonthApiCallCount,
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
        <RecalculateButton
          endpoint="/api/tenants/me/recalculate"
          label="API 利用量を再集計"
        />
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
          title="当月の LLM/Embedding 呼出回数 (withMeteredLLM 経由)"
        >
          <p className="text-xs text-muted-foreground">API 呼出</p>
          <p className="text-xl font-bold">
            {info.currentMonthApiCallCount.toLocaleString()}
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
            title="Beginner プランは月 100 回までの API 呼出が無料です。残数が 0 になると当月は LLM 呼出が停止します"
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
              title="当月の内部請求額。Expert ¥10/call / Pro ¥30/call の固定単価で計算"
            >
              <p className="text-xs text-muted-foreground">API 費用</p>
              <p className="text-xl font-bold">
                ¥{info.currentMonthApiCostJpy.toLocaleString()}
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
      // セルフサインアウト → ログイン画面へリダイレクト
      await fetch('/api/auth/signout', { method: 'POST' }).catch(() => undefined);
      router.replace('/login');
      router.refresh();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="mt-8 space-y-3 rounded border border-destructive/40 p-4">
      <h2 className="text-lg font-semibold text-destructive">テナント解約 (危険な操作)</h2>
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
    </section>
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

function BillingContactSection({ initialInfo }: { initialInfo: TenantSelfInfo }) {
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
    paymentMethod: initialInfo.paymentMethod || 'invoice',
  });
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setSubmitting(true);

    try {
      const res = await fetch('/api/tenants/me/billing', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...form,
          // 2026-05-09 (PR C / #5): 個人プラン時は会社名を null クリア (UI 非表示でも残値防止)
          billingCompanyName:
            form.billingType === 'individual'
              ? null
              : form.billingCompanyName.trim() || null,
          // (#10) 建物名は任意 (空文字は null クリア)
          billingBuildingName: form.billingBuildingName.trim() || null,
          // 空文字は null に正規化 (= 値クリア)
          billingPhoneNumber: form.billingPhoneNumber.trim() || null,
        }),
      });

      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        const code = json?.error?.code as string | undefined;
        const message = json?.error?.message as string | undefined;
        if (code === 'VALIDATION_ERROR') setError(message ?? '入力内容に誤りがあります');
        else setError(message ?? '更新に失敗しました');
        showError('請求先情報の更新に失敗しました');
        return;
      }

      showSuccess('請求先情報を更新しました');
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
          <option value="invoice">請求書送付</option>
          <option value="bank_transfer">銀行振込</option>
          {/* 2026-05-09 (#4): クレジットカード決済は未対応のため非活性。選択肢としては
              将来対応を予告するため残す。サーバ側 zod でも 'credit_card' は reject。 */}
          <option value="credit_card" disabled>クレジットカード (今後対応予定)</option>
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
 * - 保存後は `useSession().update()` で JWT を即時更新し、再描画で反映する。
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
  const { update: updateSession } = useSession();
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
      const json = await res.json();
      // JWT 反映 (全ユーザが再ログインせずとも自分のセッションには即時反映)
      await updateSession({ timezone: json.data.timezone, locale: json.data.locale });
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
