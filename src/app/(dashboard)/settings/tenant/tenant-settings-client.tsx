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

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/toast-provider';

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
  // P-G (2026-05-08): 請求先情報
  billingCompanyName: string | null;
  billingContactName: string | null;
  billingContactEmail: string | null;
  billingAddress: string | null;
  billingPhoneNumber: string | null;
  paymentMethod: string;
  // P-B (2026-05-08): Beginner プラン期限ステータス
  beginnerExpiryState: 'active' | 'warning_60' | 'warning_75' | 'expired';
  beginnerDaysRemaining: number | null;
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
}: {
  initialInfo: TenantSelfInfo;
  storageInitialInfo: StorageInitialInfo | null;
}) {
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
      const ok = confirm(
        'ダウングレードはこの月の月末から適用されます。当月分の従量課金は通常通り発生します。続行しますか?',
      );
      if (!ok) return;
    }

    setSubmitting(true);
    try {
      const body: Record<string, unknown> = {};
      if (planChanged) body.plan = selectedPlan;
      const parsedBudget = budgetUnlimited ? null : Number(budgetCap);
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
        const date = new Date(json.data.scheduledFor).toISOString().split('T')[0];
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
      <h1 className="text-2xl font-bold">テナント設定</h1>
      <p className="text-sm text-muted-foreground">
        テナント名: {info.name}
        {info.tenantSeq != null && <span className="ml-2">(テナント #{info.tenantSeq})</span>}
      </p>

      {/* P-B (2026-05-08): Beginner プラン期限バナー */}
      <BeginnerExpiryBanner info={info} />

      {/* 当月使用量 */}
      <section className="rounded border p-4">
        <h2 className="mb-2 font-semibold">当月使用量</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div>
            <p className="text-xs text-muted-foreground">API 呼出</p>
            <p className="text-xl font-bold">{info.currentMonthApiCallCount.toLocaleString()}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">API 費用</p>
            <p className="text-xl font-bold">¥{info.currentMonthApiCostJpy.toLocaleString()}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">月次予算上限</p>
            <p className="text-xl font-bold">
              {info.monthlyBudgetCapJpy != null
                ? `¥${info.monthlyBudgetCapJpy.toLocaleString()}`
                : '無制限'}
            </p>
          </div>
        </div>
        {budgetUsagePercent !== null && (
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

      {/* 予約済プラン変更 */}
      {info.scheduledPlanChangeAt && info.scheduledNextPlan && (
        <section className="rounded border border-amber-300 bg-amber-50 p-4 text-sm dark:bg-amber-900/30">
          <p>
            <strong>プラン変更予約あり:</strong>{' '}
            {new Date(info.scheduledPlanChangeAt).toISOString().split('T')[0]} に{' '}
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
            アップグレードは即時反映、ダウングレードは月末で予約反映されます。
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

        <section className="rounded border p-4">
          <h2 className="mb-2 font-semibold">月次予算上限</h2>
          <p className="mb-3 text-xs text-muted-foreground">
            上限を超えそうな時に LLM 呼出を停止します。Beginner プランでは無効 (上限が固定)。
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

        <Button type="submit" disabled={submitting || beginnerSeatsExceeded}>
          {submitting ? '更新中...' : '変更を保存'}
        </Button>
      </form>

      {/* Storage add-on (Phase 2 / 2026-05-08): ストレージプラン管理 */}
      {storageInitialInfo && <StorageAddonSection initialInfo={storageInitialInfo} />}

      {/* P-G (2026-05-08): 請求先情報の編集 */}
      <BillingContactSection initialInfo={info} />

      {/* P-C (2026-05-08): データエクスポート */}
      <DataExportSection />

      {/* P-D (2026-05-08): データインポート */}
      <DataImportSection />
    </div>
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
        const date = new Date(json.data.scheduledFor).toISOString().split('T')[0];
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

      {/* 予約済プラン変更 */}
      {info.scheduledStorageAddonAt && info.scheduledNextStorageAddon && (
        <div className="mb-3 rounded border border-amber-300 bg-amber-50 p-3 text-sm dark:bg-amber-900/30">
          <p>
            <strong>ストレージプラン変更予約あり:</strong>{' '}
            {info.scheduledStorageAddonAt.split('T')[0]} に{' '}
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
// P-G: 請求先情報の編集セクション
// ================================================================

function BillingContactSection({ initialInfo }: { initialInfo: TenantSelfInfo }) {
  const router = useRouter();
  const { showSuccess, showError } = useToast();

  const [form, setForm] = useState({
    billingCompanyName: initialInfo.billingCompanyName ?? '',
    billingContactName: initialInfo.billingContactName ?? '',
    billingContactEmail: initialInfo.billingContactEmail ?? '',
    billingAddress: initialInfo.billingAddress ?? '',
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

      <div className="space-y-2">
        <label htmlFor="billingContactName" className="text-sm font-medium">請求担当者名 *</label>
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

      <div className="space-y-2">
        <label htmlFor="billingAddress" className="text-sm font-medium">請求書送付先住所 *</label>
        <textarea
          id="billingAddress"
          className="w-full rounded border p-2 text-sm"
          rows={3}
          value={form.billingAddress}
          onChange={(e) => setForm({ ...form, billingAddress: e.target.value })}
          required
        />
      </div>

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
          <option value="credit_card">クレジットカード (今後対応予定)</option>
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
 *   - warning_75 (Day 75〜89): 強橙バナー (= 強い警告 +「期限後はエクスポート不可」)
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
