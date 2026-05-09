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
  billingCompanyName: string;
  billingContactName: string;
  billingContactEmail: string;
  billingAddress: string;
  billingPhoneNumber: string;
  paymentMethod: 'invoice' | 'bank_transfer' | 'credit_card';
  initialAdminName: string;
  initialAdminEmail: string;
};

const INITIAL: FormState = {
  name: '',
  slug: '',
  plan: 'beginner',
  billingCompanyName: '',
  billingContactName: '',
  billingContactEmail: '',
  billingAddress: '',
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
        <div className="space-y-2">
          <Label htmlFor="billingContactName">請求担当者名 *</Label>
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
        <div className="space-y-2">
          <Label htmlFor="billingAddress">請求書送付先住所 *</Label>
          <textarea
            id="billingAddress"
            value={form.billingAddress}
            onChange={(e) => setForm({ ...form, billingAddress: e.target.value })}
            className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            rows={3}
            required
          />
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
