'use client';

/**
 * テナント新規作成フォーム (P-G / 2026-05-08)
 *
 * super_admin が POST /api/admin/super/tenants で新規テナントを作成する。
 * 入力項目: 表示名 / slug / プラン / 請求先 4 項目 / 任意 (電話 + 支払方法) / 初期 admin。
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useLoading } from '@/components/loading-overlay';
import { useToast } from '@/components/toast-provider';
import { nativeSelectClass } from '@/components/ui/native-select-style';

type FormState = {
  name: string;
  slug: string;
  plan: 'beginner' | 'expert' | 'pro';
  // 2026-05-09 (PR C / #5): 個人 / 法人 切替
  billingType: 'corporate' | 'individual';
  billingCompanyName: string;
  billingContactName: string;
  billingContactEmail: string;
  // 2026-05-09 (PR C / #8): 住所サブフィールド化
  billingPostalCode: string;
  billingPrefecture: string;
  billingCity: string;
  billingStreetAddress: string;
  // (#10) 任意
  billingBuildingName: string;
  billingPhoneNumber: string;
  // 2026-05-15: 'bank_transfer' は廃止し 'invoice' に統合 (UI ラベル「銀行振込」, 内部値 'invoice')。
  paymentMethod: 'invoice' | 'credit_card';
  initialAdminName: string;
  initialAdminEmail: string;
};

const INITIAL: FormState = {
  name: '',
  slug: '',
  plan: 'beginner',
  billingType: 'corporate',
  billingCompanyName: '',
  billingContactName: '',
  billingContactEmail: '',
  billingPostalCode: '',
  billingPrefecture: '',
  billingCity: '',
  billingStreetAddress: '',
  billingBuildingName: '',
  billingPhoneNumber: '',
  paymentMethod: 'invoice',
  initialAdminName: '',
  initialAdminEmail: '',
};

export function TenantCreateForm({
  stripeEnabled,
}: {
  /**
   * feat/credit-card-ui-guard (2026-05-30): STRIPE_ENABLED feature flag。
   * false の場合、credit_card option を選択不可にして 403 エラーの誤誘発を防ぐ
   * (= サーバ側 403 ガードと整合させる二段ガード、KDD §5.X+184)。
   */
  stripeEnabled: boolean;
}) {
  const router = useRouter();
  const t = useTranslations('superAdmin');
  const { withLoading } = useLoading();
  const { showSuccess, showError } = useToast();

  const [form, setForm] = useState<FormState>(INITIAL);
  const [error, setError] = useState('');
  // ADR-0016 (2026-05-20): 既登録 email チェック (Beginner abuse 防止 + UI 誘導)
  const [beginnerAvailable, setBeginnerAvailable] = useState<boolean | null>(null);
  const [eligibilityHint, setEligibilityHint] = useState('');

  useEffect(() => {
    const billing = form.billingContactEmail.trim();
    const admin = form.initialAdminEmail.trim();
    const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailPattern.test(billing) || !emailPattern.test(admin)) {
      // ADR-0016: 不正 email では何もしない。reset は onChange で行う (lint: set-state-in-effect 回避)
      return;
    }
    const timer = setTimeout(async () => {
      const res = await fetch('/api/auth/check-tenant-eligibility', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ billingContactEmail: billing, initialAdminEmail: admin }),
      }).catch(() => null);
      if (!res || !res.ok) {
        setBeginnerAvailable(null);
        setEligibilityHint('');
        return;
      }
      const json = (await res.json().catch(() => null)) as
        | { beginnerAvailable: boolean; reason?: string; message?: string }
        | null;
      if (!json) return;
      setBeginnerAvailable(json.beginnerAvailable);
      setEligibilityHint(json.beginnerAvailable ? '' : (json.message ?? ''));
      if (!json.beginnerAvailable && form.plan === 'beginner') {
        setForm((prev) => ({ ...prev, plan: 'expert' }));
      }
    }, 500);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.billingContactEmail, form.initialAdminEmail]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');

    const payload = {
      ...form,
      // 2026-05-09 (PR C / #5): 個人プラン時は会社名を送らない
      billingCompanyName: form.billingType === 'individual' ? undefined : form.billingCompanyName,
      // (#10) 建物名は任意
      billingBuildingName: form.billingBuildingName.trim() || undefined,
      // optional 値の空文字は undefined 扱いに
      billingPhoneNumber: form.billingPhoneNumber.trim() || undefined,
    };

    const res = await withLoading(() =>
      fetch('/api/admin/super/tenants', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }),
    );

    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const code = json?.error?.code as string | undefined;
      const message = json?.error?.message as string | undefined;
      if (code === 'SLUG_CONFLICT') setError(t('tenantCreateErrorSlugConflict'));
      // ADR-0016 (2026-05-20): EMAIL_CONFLICT は廃止 (tenant-scoped 一意化で発生不能)
      // ADR-0016 (2026-05-20): BEGINNER_REQUIRES_UPGRADE = サーバ側 defense-in-depth
      else if (code === 'BEGINNER_REQUIRES_UPGRADE') setError(message ?? t('tenantCreateErrorBeginnerRequiresUpgrade'));
      else if (code === 'EMAIL_SEND_FAILED') setError(t('tenantCreateErrorEmailSendFailed'));
      else if (code === 'VALIDATION_ERROR') setError(message ?? t('tenantCreateErrorValidation'));
      else setError(message ?? t('tenantCreateErrorDefault'));
      showError(t('tenantCreateToastFailed'));
      return;
    }

    const newTenantId = json?.data?.tenantId as string;
    showSuccess(t('tenantCreateToastSuccess', { name: form.name }));
    router.push(`/admin/super/tenants/${newTenantId}`);
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {error && (
        <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>
      )}

      <fieldset className="space-y-4 rounded border p-4">
        <legend className="text-sm font-semibold">{t('tenantCreateBasicInfoLegend')}</legend>
        <div className="space-y-2">
          <Label htmlFor="name">{t('tenantCreateLabelName')}</Label>
          <Input
            id="name"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            maxLength={100}
            required
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="slug">{t('tenantCreateLabelSlug')}</Label>
          <Input
            id="slug"
            value={form.slug}
            onChange={(e) => setForm({ ...form, slug: e.target.value.toLowerCase() })}
            placeholder={t('tenantCreateSlugPlaceholder')}
            pattern="[a-z0-9](?:[-a-z0-9]{1,58}[a-z0-9])?"
            required
          />
          <p className="text-xs text-muted-foreground">
            {t('tenantCreateSlugHint')}
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="plan">{t('tenantCreateLabelPlan')}</Label>
          <select
            id="plan"
            value={form.plan}
            onChange={(e) => setForm({ ...form, plan: e.target.value as FormState['plan'] })}
            className={nativeSelectClass}
          >
            <option value="beginner" disabled={beginnerAvailable === false}>
              {t('tenantCreatePlanBeginner')}
              {beginnerAvailable === false ? t('tenantCreatePlanBeginnerUnavailableSuffix') : ''}
            </option>
            <option value="expert">{t('tenantCreatePlanExpert')}</option>
            <option value="pro">{t('tenantCreatePlanPro')}</option>
          </select>
          {beginnerAvailable === false && eligibilityHint && (
            <p
              className="rounded-md bg-info/10 p-2 text-xs text-info"
              data-testid="beginner-unavailable-hint"
            >
              ℹ {eligibilityHint}
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            {/* ADR-0016 (2026-05-20): P-B 強化 — 既登録 email は Beginner 不可 (abuse 防止) */}
            <strong>{t('tenantCreatePlanHintNoticeBold')}</strong>{t('tenantCreatePlanHintBody')}
          </p>
        </div>
      </fieldset>

      <fieldset className="space-y-4 rounded border p-4">
        <legend className="text-sm font-semibold">{t('tenantCreateBillingLegend')}</legend>

        {/* 2026-05-09 (PR C / #5): 個人 / 法人 切替 */}
        <div className="space-y-2">
          <Label>{t('tenantCreateLabelBillingType')}</Label>
          <div className="flex gap-4 text-sm">
            <label className="flex items-center gap-1.5">
              <input
                type="radio"
                name="billingType"
                value="corporate"
                checked={form.billingType === 'corporate'}
                onChange={() => setForm({ ...form, billingType: 'corporate' })}
              />
              {t('tenantCreateBillingTypeCorporate')}
            </label>
            <label className="flex items-center gap-1.5">
              <input
                type="radio"
                name="billingType"
                value="individual"
                checked={form.billingType === 'individual'}
                onChange={() => setForm({ ...form, billingType: 'individual', billingCompanyName: '' })}
              />
              {t('tenantCreateBillingTypeIndividual')}
            </label>
          </div>
        </div>

        {form.billingType === 'corporate' && (
          <div className="space-y-2">
            <Label htmlFor="billingCompanyName">{t('tenantCreateLabelCompanyName')}</Label>
            <Input
              id="billingCompanyName"
              value={form.billingCompanyName}
              onChange={(e) => setForm({ ...form, billingCompanyName: e.target.value })}
              maxLength={200}
              required
            />
          </div>
        )}

        <div className="space-y-2">
          <Label htmlFor="billingContactName">
            {form.billingType === 'corporate' ? t('tenantCreateLabelContactNameCorporate') : t('tenantCreateLabelContactNameIndividual')}
          </Label>
          <Input
            id="billingContactName"
            value={form.billingContactName}
            onChange={(e) => setForm({ ...form, billingContactName: e.target.value })}
            maxLength={100}
            required
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="billingContactEmail">{t('tenantCreateLabelContactEmail')}</Label>
          <Input
            id="billingContactEmail"
            type="email"
            value={form.billingContactEmail}
            onChange={(e) => setForm({ ...form, billingContactEmail: e.target.value })}
            maxLength={255}
            required
          />
        </div>

        {/* 2026-05-09 (PR C / #8): 住所をサブフィールドに分割 */}
        <div className="space-y-2">
          <Label htmlFor="billingPostalCode">{t('tenantCreateLabelPostalCode')}</Label>
          <Input
            id="billingPostalCode"
            value={form.billingPostalCode}
            onChange={(e) => setForm({ ...form, billingPostalCode: e.target.value })}
            maxLength={10}
            placeholder={t('tenantCreatePostalCodePlaceholder')}
            pattern="\d{3}-?\d{4}"
            required
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-2">
            <Label htmlFor="billingPrefecture">{t('tenantCreateLabelPrefecture')}</Label>
            <Input id="billingPrefecture" value={form.billingPrefecture} onChange={(e) => setForm({ ...form, billingPrefecture: e.target.value })} maxLength={20} placeholder={t('tenantCreatePrefecturePlaceholder')} required />
          </div>
          <div className="space-y-2">
            <Label htmlFor="billingCity">{t('tenantCreateLabelCity')}</Label>
            <Input id="billingCity" value={form.billingCity} onChange={(e) => setForm({ ...form, billingCity: e.target.value })} maxLength={100} placeholder={t('tenantCreateCityPlaceholder')} required />
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="billingStreetAddress">{t('tenantCreateLabelStreet')}</Label>
          <Input id="billingStreetAddress" value={form.billingStreetAddress} onChange={(e) => setForm({ ...form, billingStreetAddress: e.target.value })} maxLength={200} placeholder={t('tenantCreateStreetPlaceholder')} required />
        </div>
        {/* 2026-05-09 (#10): 任意 */}
        <div className="space-y-2">
          <Label htmlFor="billingBuildingName">{t('tenantCreateLabelBuilding')}</Label>
          <Input id="billingBuildingName" value={form.billingBuildingName} onChange={(e) => setForm({ ...form, billingBuildingName: e.target.value })} maxLength={200} placeholder={t('tenantCreateBuildingPlaceholder')} />
        </div>

        <div className="space-y-2">
          <Label htmlFor="billingPhoneNumber">{t('tenantCreateLabelPhone')}</Label>
          <Input
            id="billingPhoneNumber"
            value={form.billingPhoneNumber}
            onChange={(e) => setForm({ ...form, billingPhoneNumber: e.target.value })}
            maxLength={20}
            placeholder={t('tenantCreatePhonePlaceholder')}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="paymentMethod">{t('tenantCreateLabelPaymentMethod')}</Label>
          <select
            id="paymentMethod"
            value={form.paymentMethod}
            onChange={(e) =>
              setForm({ ...form, paymentMethod: e.target.value as FormState['paymentMethod'] })
            }
            className={nativeSelectClass}
          >
            {/* 2026-05-15: 旧 'invoice'（請求書送付）と 'bank_transfer'（銀行振込）を「銀行振込」に統合 (内部値 'invoice')。 */}
            <option value="invoice">{t('tenantCreatePaymentInvoice')}</option>
            {/* feat/db-storage-overage-subscription-items (2026-05-30): Stripe Subscription Item
                5 項目化完遂と invariant 一致担保により、feat/credit-card-pending の読み取り専用を解除。
                feat/credit-card-ui-guard (2026-05-30): STRIPE_ENABLED=false の場合は option を
                disabled 化 (= サーバ側 403 ガードと整合、KDD §5.X+184)。 */}
            <option value="credit_card" disabled={!stripeEnabled}>
              {stripeEnabled ? t('tenantCreatePaymentCreditCardAvailable') : t('tenantCreatePaymentCreditCardPreparing')}
            </option>
          </select>
        </div>
      </fieldset>

      <fieldset className="space-y-4 rounded border p-4">
        <legend className="text-sm font-semibold">{t('tenantCreateInitialAdminLegend')}</legend>
        <p className="text-xs text-muted-foreground">
          {t('tenantCreateInitialAdminDescription')}
        </p>
        <div className="space-y-2">
          <Label htmlFor="initialAdminName">{t('tenantCreateLabelAdminName')}</Label>
          <Input
            id="initialAdminName"
            value={form.initialAdminName}
            onChange={(e) => setForm({ ...form, initialAdminName: e.target.value })}
            maxLength={100}
            required
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="initialAdminEmail">{t('tenantCreateLabelAdminEmail')}</Label>
          <Input
            id="initialAdminEmail"
            type="email"
            value={form.initialAdminEmail}
            onChange={(e) => setForm({ ...form, initialAdminEmail: e.target.value })}
            maxLength={255}
            required
          />
        </div>
      </fieldset>

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={() => router.back()}>
          {t('tenantCreateCancel')}
        </Button>
        <Button type="submit">{t('tenantCreateSubmit')}</Button>
      </div>
    </form>
  );
}
