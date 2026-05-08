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

export function TenantSettingsClient({ initialInfo }: { initialInfo: TenantSelfInfo }) {
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

      {/* P-G (2026-05-08): 請求先情報の編集 */}
      <BillingContactSection initialInfo={info} />
    </div>
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
