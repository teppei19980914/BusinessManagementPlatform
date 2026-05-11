'use client';

/**
 * /signup (P-G / 2026-05-08)
 *
 * 公開セルフサインアップ画面。外部ユーザがテナントを開設する経路。
 *
 * UX:
 *   - 1 画面 1 フォームでテナント情報 + 請求先 + 初期 admin を入力
 *   - 送信成功 → 「招待メールを送信しました」メッセージ + ログイン画面へのリンク
 *   - bot 対策: 視覚的に隠した honeypot field (hp_url) を含める
 *
 * セキュリティ:
 *   - POST 先 (/api/auth/signup) で IP-based rate limit + honeypot 検知
 *   - パスワード未送信 (= 仮登録、検証メール経由でパスワード設定)
 */

import { useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

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
  // (#10) 建物名・部屋番号は任意
  billingBuildingName: string;
  billingPhoneNumber: string;
  paymentMethod: 'invoice' | 'bank_transfer' | 'credit_card';
  initialAdminName: string;
  initialAdminEmail: string;
  /** Honeypot: bot が自動入力するフィールド。通常ユーザは空のまま */
  hp_url: string;
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
  hp_url: '',
};

export default function SignupPage() {
  const [form, setForm] = useState<FormState>(INITIAL);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setSubmitting(true);

    try {
      // 2026-05-09 (PR C / #5): 個人プラン時は会社名を送らない (= サーバ側で null 保存)。
      //   (#10) 建物名は空文字 → undefined に正規化。
      const payload = {
        ...form,
        billingCompanyName: form.billingType === 'individual' ? undefined : form.billingCompanyName,
        billingBuildingName: form.billingBuildingName.trim() || undefined,
        billingPhoneNumber: form.billingPhoneNumber.trim() || undefined,
      };

      const res = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        const code = json?.error?.code as string | undefined;
        const message = json?.error?.message as string | undefined;
        if (code === 'SLUG_CONFLICT') setError('この組織 ID は既に使用されています。別の ID を入力してください。');
        else if (code === 'EMAIL_CONFLICT') setError('このメールアドレスは既に他のテナントで使用されています。');
        else if (code === 'EMAIL_SEND_FAILED') setError('招待メール送信に失敗したため登録を取り消しました。メールアドレスを確認のうえ再度お試しください。');
        else if (code === 'RATE_LIMITED') setError('短時間に多くの申込がありました。1 時間後に再度お試しください。');
        else setError(message ?? '登録に失敗しました。');
        return;
      }

      setSuccess(true);
    } finally {
      setSubmitting(false);
    }
  }

  if (success) {
    return (
      <div className="mx-auto my-12 max-w-md px-4">
        <Card>
          <CardHeader>
            <CardTitle>招待メールを送信しました</CardTitle>
            <CardDescription>
              入力したメールアドレス宛に、パスワード設定リンクを記載した招待メールを送信しました。
              メール本文のリンクをクリックしてパスワードを設定すると、ログインできるようになります。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              メールが届かない場合は、迷惑メールフォルダもご確認ください。
            </p>
            <Link
              href="/login"
              className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-xs hover:bg-primary/90"
            >
              ログイン画面へ
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto my-8 max-w-2xl px-4">
      <Card>
        <CardHeader>
          <CardTitle>たすきば サインアップ</CardTitle>
          <CardDescription>
            新規テナント (組織) を開設します。<strong>Beginner プラン (90 日試用、月 100 回まで無料)</strong>{' '}
            で開始されます。期限後は読み取り専用モードに移行し、エクスポートも停止します。
            引き続きご利用の場合は試用期間内に Expert / Pro プランへのアップグレードをお願いします。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-6">
            {/* Honeypot: 視覚的に隠す。bot が自動入力するとサーバ側で reject */}
            <div aria-hidden="true" className="absolute left-[-9999px] h-0 w-0 overflow-hidden">
              <label htmlFor="hp_url">Website (do not fill)</label>
              <input
                id="hp_url"
                name="hp_url"
                type="text"
                tabIndex={-1}
                autoComplete="off"
                value={form.hp_url}
                onChange={(e) => setForm({ ...form, hp_url: e.target.value })}
              />
            </div>

            {error && (
              <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>
            )}

            <fieldset className="space-y-3 rounded border p-4">
              <legend className="px-1 text-sm font-semibold">テナント (組織) 情報</legend>
              <div className="space-y-1.5">
                <Label htmlFor="name">表示用テナント名 *</Label>
                <Input id="name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={100} required />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="slug">組織 ID *</Label>
                <Input id="slug" value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value.toLowerCase() })} placeholder="例: my-company" pattern="[a-z0-9](?:[a-z0-9-]{1,58}[a-z0-9])?" required />
                <p className="text-xs text-muted-foreground">英小文字・数字・ハイフンのみ、3〜60 文字</p>
              </div>
            </fieldset>

            <fieldset className="space-y-3 rounded border p-4">
              <legend className="px-1 text-sm font-semibold">請求先情報</legend>

              {/* 2026-05-09 (PR C / #5): 個人 / 法人 切替 */}
              <div className="space-y-1.5">
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

              {/* 2026-05-09 (#5): 法人選択時のみ会社名を表示・必須 */}
              {form.billingType === 'corporate' && (
                <div className="space-y-1.5">
                  <Label htmlFor="billingCompanyName">会社名 / 法人名 *</Label>
                  <Input id="billingCompanyName" value={form.billingCompanyName} onChange={(e) => setForm({ ...form, billingCompanyName: e.target.value })} maxLength={200} required />
                </div>
              )}

              <div className="space-y-1.5">
                <Label htmlFor="billingContactName">
                  {form.billingType === 'corporate' ? '請求担当者名 *' : 'お名前 *'}
                </Label>
                <Input id="billingContactName" value={form.billingContactName} onChange={(e) => setForm({ ...form, billingContactName: e.target.value })} maxLength={100} required />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="billingContactEmail">請求先メール *</Label>
                <Input id="billingContactEmail" type="email" value={form.billingContactEmail} onChange={(e) => setForm({ ...form, billingContactEmail: e.target.value })} maxLength={255} required />
              </div>

              {/* 2026-05-09 (PR C / #8): 住所をサブフィールドに分割 */}
              <div className="space-y-1.5">
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
                <div className="space-y-1.5">
                  <Label htmlFor="billingPrefecture">都道府県 *</Label>
                  <Input id="billingPrefecture" value={form.billingPrefecture} onChange={(e) => setForm({ ...form, billingPrefecture: e.target.value })} maxLength={20} placeholder="例: 東京都" required />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="billingCity">市区町村 *</Label>
                  <Input id="billingCity" value={form.billingCity} onChange={(e) => setForm({ ...form, billingCity: e.target.value })} maxLength={100} placeholder="例: 千代田区" required />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="billingStreetAddress">番地・町名 *</Label>
                <Input id="billingStreetAddress" value={form.billingStreetAddress} onChange={(e) => setForm({ ...form, billingStreetAddress: e.target.value })} maxLength={200} placeholder="例: 千代田1-1" required />
              </div>
              {/* 2026-05-09 (#10): 建物名・部屋番号は任意 */}
              <div className="space-y-1.5">
                <Label htmlFor="billingBuildingName">建物名・部屋番号 (任意)</Label>
                <Input id="billingBuildingName" value={form.billingBuildingName} onChange={(e) => setForm({ ...form, billingBuildingName: e.target.value })} maxLength={200} placeholder="例: 〇〇ビル 5F" />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="billingPhoneNumber">電話番号 (任意)</Label>
                <Input id="billingPhoneNumber" value={form.billingPhoneNumber} onChange={(e) => setForm({ ...form, billingPhoneNumber: e.target.value })} maxLength={20} placeholder="例: 03-1234-5678" />
              </div>
            </fieldset>

            <fieldset className="space-y-3 rounded border p-4">
              <legend className="px-1 text-sm font-semibold">初期管理者 (ログイン用)</legend>
              <p className="text-xs text-muted-foreground">
                このメールアドレスに招待メールが届きます。リンクからパスワードを設定するとログインできるようになります。
              </p>
              <div className="space-y-1.5">
                <Label htmlFor="initialAdminName">氏名 *</Label>
                <Input id="initialAdminName" value={form.initialAdminName} onChange={(e) => setForm({ ...form, initialAdminName: e.target.value })} maxLength={100} required />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="initialAdminEmail">メールアドレス *</Label>
                <Input id="initialAdminEmail" type="email" value={form.initialAdminEmail} onChange={(e) => setForm({ ...form, initialAdminEmail: e.target.value })} maxLength={255} required />
              </div>
            </fieldset>

            <Button type="submit" className="w-full" disabled={submitting}>
              {submitting ? '送信中...' : 'サインアップ'}
            </Button>

            <p className="text-center text-sm text-muted-foreground">
              既にアカウントをお持ちの場合は <Link href="/login" className="text-info hover:underline">ログイン</Link> してください
            </p>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
