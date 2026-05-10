'use client';

/**
 * テナント新規作成フォーム (P-G / 2026-05-08)
 *
 * super_admin が POST /api/admin/super/tenants で新規テナントを作成する。
 * 入力項目: 表示名 / slug / プラン / 請求先 4 項目 / 任意 (電話 + 支払方法) / 初期 admin。
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
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
  paymentMethod: 'invoice' | 'bank_transfer' | 'credit_card';
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

export function TenantCreateForm() {
  const router = useRouter();
  const { withLoading } = useLoading();
  const { showSuccess, showError } = useToast();

  const [form, setForm] = useState<FormState>(INITIAL);
  const [error, setError] = useState('');

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
      if (code === 'SLUG_CONFLICT') setError('この URL slug は既に使用されています。別の slug を入力してください。');
      else if (code === 'EMAIL_CONFLICT') setError('このメールアドレスは既に他のテナントで使用されています。');
      else if (code === 'EMAIL_SEND_FAILED') setError('招待メール送信に失敗したためテナント作成を取り消しました。メールアドレスを確認のうえ再試行してください。');
      else if (code === 'VALIDATION_ERROR') setError(message ?? '入力内容に誤りがあります。');
      else setError(message ?? '作成に失敗しました。');
      showError('テナント作成に失敗しました');
      return;
    }

    const newTenantId = json?.data?.tenantId as string;
    showSuccess(`テナント「${form.name}」を作成しました。初期管理者に招待メールを送信しました。`);
    router.push(`/admin/super/tenants/${newTenantId}`);
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {error && (
        <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>
      )}

      <fieldset className="space-y-4 rounded border p-4">
        <legend className="text-sm font-semibold">基本情報</legend>
        <div className="space-y-2">
          <Label htmlFor="name">表示用テナント名 *</Label>
          <Input
            id="name"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            maxLength={100}
            required
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="slug">URL slug *</Label>
          <Input
            id="slug"
            value={form.slug}
            onChange={(e) => setForm({ ...form, slug: e.target.value.toLowerCase() })}
            placeholder="例: customer-abc"
            pattern="[a-z0-9](?:[a-z0-9-]{1,58}[a-z0-9])?"
            required
          />
          <p className="text-xs text-muted-foreground">
            英小文字・数字・ハイフン、3〜60 文字。後から変更不可。
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="plan">プラン *</Label>
          <select
            id="plan"
            value={form.plan}
            onChange={(e) => setForm({ ...form, plan: e.target.value as FormState['plan'] })}
            className={nativeSelectClass}
          >
            <option value="beginner">Beginner (¥0、月 100 回上限、5 席、90 日試用)</option>
            <option value="expert">Expert (¥10/call)</option>
            <option value="pro">Pro (¥30/call、Sonnet 説明文付)</option>
          </select>
          <p className="text-xs text-muted-foreground">
            <strong>P-B (2026-05-08) 注意</strong>: Beginner で作成 → 試用 90 日後に読み取り専用モードに移行。
            Expert / Pro で作成 → 例外的に Beginner 試用対象外として開設 (= 後で Beginner にダウングレード不可)。
          </p>
        </div>
      </fieldset>

      <fieldset className="space-y-4 rounded border p-4">
        <legend className="text-sm font-semibold">請求先情報 (必須)</legend>

        {/* 2026-05-09 (PR C / #5): 個人 / 法人 切替 */}
        <div className="space-y-2">
          <Label>請求先種別 *</Label>
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
            <Label htmlFor="billingCompanyName">会社名 / 法人名 *</Label>
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
            {form.billingType === 'corporate' ? '請求担当者名 *' : 'お名前 *'}
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
          <Label htmlFor="billingContactEmail">請求先メール *</Label>
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
          <Label htmlFor="billingPostalCode">郵便番号 *</Label>
          <Input
            id="billingPostalCode"
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
            <Label htmlFor="billingPrefecture">都道府県 *</Label>
            <Input id="billingPrefecture" value={form.billingPrefecture} onChange={(e) => setForm({ ...form, billingPrefecture: e.target.value })} maxLength={20} placeholder="例: 東京都" required />
          </div>
          <div className="space-y-2">
            <Label htmlFor="billingCity">市区町村 *</Label>
            <Input id="billingCity" value={form.billingCity} onChange={(e) => setForm({ ...form, billingCity: e.target.value })} maxLength={100} placeholder="例: 千代田区" required />
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="billingStreetAddress">番地・町名 *</Label>
          <Input id="billingStreetAddress" value={form.billingStreetAddress} onChange={(e) => setForm({ ...form, billingStreetAddress: e.target.value })} maxLength={200} placeholder="例: 千代田1-1" required />
        </div>
        {/* 2026-05-09 (#10): 任意 */}
        <div className="space-y-2">
          <Label htmlFor="billingBuildingName">建物名・部屋番号 (任意)</Label>
          <Input id="billingBuildingName" value={form.billingBuildingName} onChange={(e) => setForm({ ...form, billingBuildingName: e.target.value })} maxLength={200} placeholder="例: 〇〇ビル 5F" />
        </div>

        <div className="space-y-2">
          <Label htmlFor="billingPhoneNumber">電話番号 (任意)</Label>
          <Input
            id="billingPhoneNumber"
            value={form.billingPhoneNumber}
            onChange={(e) => setForm({ ...form, billingPhoneNumber: e.target.value })}
            maxLength={20}
            placeholder="例: 03-1234-5678"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="paymentMethod">支払い方法 *</Label>
          <select
            id="paymentMethod"
            value={form.paymentMethod}
            onChange={(e) =>
              setForm({ ...form, paymentMethod: e.target.value as FormState['paymentMethod'] })
            }
            className={nativeSelectClass}
          >
            <option value="invoice">請求書送付</option>
            <option value="bank_transfer">銀行振込</option>
            {/* 2026-05-09 (#4): クレジットカード決済は未対応のため非活性。 */}
            <option value="credit_card" disabled>クレジットカード (今後対応予定)</option>
          </select>
        </div>
      </fieldset>

      <fieldset className="space-y-4 rounded border p-4">
        <legend className="text-sm font-semibold">初期管理者 (= 招待メール送付先)</legend>
        <p className="text-xs text-muted-foreground">
          このテナントの最初の admin ユーザを 1 名作成します。指定したメールアドレスに招待メールが送信され、
          リンクをクリックしてパスワードを設定するとログインできるようになります。
        </p>
        <div className="space-y-2">
          <Label htmlFor="initialAdminName">氏名 *</Label>
          <Input
            id="initialAdminName"
            value={form.initialAdminName}
            onChange={(e) => setForm({ ...form, initialAdminName: e.target.value })}
            maxLength={100}
            required
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="initialAdminEmail">メールアドレス *</Label>
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
          キャンセル
        </Button>
        <Button type="submit">テナントを作成</Button>
      </div>
    </form>
  );
}
