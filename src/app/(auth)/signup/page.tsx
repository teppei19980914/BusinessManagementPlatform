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

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { TERMS_URL, PRIVACY_URL } from '@/config/legal-versions';
import { getDiscordInviteUrl } from '@/config/community';

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
  // 2026-05-15: 'bank_transfer' は廃止し 'invoice' に統合 (UI ラベル「銀行振込」, 内部値 'invoice')。
  paymentMethod: 'invoice' | 'credit_card';
  initialAdminName: string;
  initialAdminEmail: string;
  // feat/legal-pages-lp-integration (2026-05-21): 規約・プラポリ同意
  //   2 つを別々に持つことで、後日「規約だけ更新 → 規約だけ再同意」のフローに拡張可能。
  acceptedTerms: boolean;
  acceptedPrivacy: boolean;
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
  acceptedTerms: false,
  acceptedPrivacy: false,
  hp_url: '',
};

export default function SignupPage() {
  const [form, setForm] = useState<FormState>(INITIAL);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // ADR-0016 Revised (2026-05-22): 3 層判定。
  //   - signupAllowed=false (層 1): フォーム全体 disable + admin 問合せ動線
  //   - beginnerAvailable=false (層 2): Beginner radio disable + Expert/Pro 自動切替
  //   - 両方 true (層 3): 全プラン選択可
  const [signupAllowed, setSignupAllowed] = useState<boolean>(true);
  const [beginnerAvailable, setBeginnerAvailable] = useState<boolean | null>(null);
  const [eligibilityHint, setEligibilityHint] = useState('');
  const discordUrl = getDiscordInviteUrl();

  // Phase 1 (2026-05-23 / feat/signup-email-resend-ux): 招待メール再送 UX 用 state。
  //   配送 fail 時 (Brevo 拒否 / 受信側 DMARC fail / spam 振分等) に顧客が自己解決できるよう、
  //   成功画面に「再送ボタン + クールダウン + 残り回数表示」を提供する。
  //   サーバ側 Rate Limit (IP 3/h + tenant 3/h + email 5/day) と同期した UI 制御。
  const [resendCount, setResendCount] = useState(0);
  const [resendStatus, setResendStatus] = useState<
    'idle' | 'sending' | 'success' | 'rate_limited' | 'failed'
  >('idle');
  const [resendMessage, setResendMessage] = useState('');
  const [resendCooldownSec, setResendCooldownSec] = useState(0);

  // クールダウンタイマー (= 連打防止 + 適度な配送待機時間を確保)
  useEffect(() => {
    if (resendCooldownSec <= 0) return;
    const id = setInterval(() => {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setResendCooldownSec((s) => (s > 0 ? s - 1 : 0));
    }, 1000);
    return () => clearInterval(id);
  }, [resendCooldownSec]);

  async function handleResend() {
    if (resendStatus === 'sending') return;
    if (resendCooldownSec > 0) return;
    setResendStatus('sending');
    setResendMessage('');
    try {
      const res = await fetch('/api/auth/resend-verification', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: form.initialAdminEmail,
          tenantSlug: form.slug,
        }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        data?: { message?: string };
        error?: { code?: string; message?: string };
      };
      if (res.ok) {
        setResendStatus('success');
        setResendCount((c) => c + 1);
        setResendMessage(json.data?.message ?? '招待メールを再送しました。');
        // UX 上、再送直後の連打防止に 60 秒のフロント側クールダウンを設ける
        // (= サーバ側 Rate Limit とは独立、操作ミス防止が目的)
        setResendCooldownSec(60);
      } else if (res.status === 429) {
        setResendStatus('rate_limited');
        setResendMessage(json.error?.message ?? '再送回数の上限に達しました。');
        // Retry-After ヘッダがあれば優先、なければ 1 時間表示
        const retryAfter = res.headers.get('Retry-After');
        setResendCooldownSec(retryAfter ? parseInt(retryAfter, 10) : 3600);
      } else {
        setResendStatus('failed');
        setResendMessage(
          json.error?.message ?? '再送に失敗しました。時間をおいて再度お試しください。',
        );
      }
    } catch {
      setResendStatus('failed');
      setResendMessage('通信エラーが発生しました。ネットワーク接続をご確認ください。');
    }
  }

  // ADR-0016 Revised (2026-05-22): initialAdminEmail が valid になった時点で
  //   check-tenant-eligibility を debounced 呼び出し。
  //   - 層 1 (signupAllowed=false): フォーム submit ボタン disable + 問合せ動線表示
  //   - 層 2 (beginnerAvailable=false): Beginner radio disable + Expert/Pro 自動切替
  //   判定キーは initialAdminEmail のみ (billingContactEmail は ADR-0016 Revised で対象外)。
  useEffect(() => {
    const admin = form.initialAdminEmail.trim();
    const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailPattern.test(admin)) {
      return;
    }
    const timer = setTimeout(async () => {
      const res = await fetch('/api/auth/check-tenant-eligibility', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initialAdminEmail: admin }),
      }).catch(() => null);
      if (!res || !res.ok) {
        // 失敗時は UI ヒント無効化 (サーバ側の 3 層判定が defense-in-depth で動く)
        setSignupAllowed(true);
        setBeginnerAvailable(null);
        setEligibilityHint('');
        return;
      }
      const json = (await res.json().catch(() => null)) as
        | {
            signupAllowed: boolean;
            beginnerAvailable: boolean;
            reason?: 'owned' | 'past_email_found' | 'none';
            message?: string;
          }
        | null;
      if (!json) return;
      setSignupAllowed(json.signupAllowed);
      setBeginnerAvailable(json.beginnerAvailable);
      setEligibilityHint(
        !json.signupAllowed || !json.beginnerAvailable ? (json.message ?? '') : '',
      );
      // 層 2: Beginner 選択中なら自動で Expert に切替
      if (json.signupAllowed && !json.beginnerAvailable && form.plan === 'beginner') {
        setForm((prev) => ({ ...prev, plan: 'expert' }));
      }
    }, 300); // debounce
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.initialAdminEmail]);

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
        // ADR-0016 (2026-05-20): EMAIL_CONFLICT は廃止 (tenant-scoped 一意化で発生不能)
        // ADR-0016 Revised (2026-05-22): 3 層判定のサーバ側 defense-in-depth エラー
        else if (code === 'OWNED_TENANT_EXISTS') setError(message ?? '入力された初期管理者メールは、既に自前テナントを保有しているユーザのものです。追加のテナント払い出しはシステム管理者へお問い合わせください。');
        else if (code === 'BEGINNER_REQUIRES_UPGRADE') setError(message ?? 'このメールアドレスは既に登録履歴があるため、Expert または Pro プランをご選択ください。');
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
    // Phase 1 (2026-05-23 / feat/signup-email-resend-ux):
    //   配送失敗時の自己解決 UX。入力メールアドレスを明示、トラブルシュート列挙、
    //   再送ボタン、最終的に運営お問い合わせ動線まで含めた包括的なサポート画面。
    return (
      <div className="mx-auto my-8 max-w-md px-4">
        <Card>
          <CardHeader>
            <CardTitle>招待メールを送信しました</CardTitle>
            <CardDescription>
              入力したメールアドレス宛に、パスワード設定リンクを記載した招待メールを送信しました。
              メール本文のリンクをクリックしてパスワードを設定すると、ログインできるようになります。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            {/* 1. 入力メールアドレスの明示表示 (= typo 確認誘導) */}
            <div className="rounded-md border border-info/30 bg-info/5 p-3 text-sm">
              <p className="m-0 text-muted-foreground">送信先</p>
              <p
                className="m-0 mt-1 font-mono text-base break-all"
                data-testid="signup-success-email"
              >
                {form.initialAdminEmail}
              </p>
              <p className="m-0 mt-2 text-xs text-muted-foreground">
                上記アドレスに誤りがある場合は、ログイン画面に戻り、サインアップをやり直してください。
              </p>
            </div>

            {/* 2. トラブルシュートチェックリスト */}
            <div className="space-y-2">
              <p className="text-sm font-semibold">メールが届かない場合の確認手順</p>
              <ol className="ml-5 list-decimal space-y-1 text-sm text-muted-foreground">
                <li>受信箱に届いていない場合は、迷惑メール / スパムフォルダもご確認ください。</li>
                <li>1〜2 分待ってから受信箱を更新してください。</li>
                <li>
                  法人メールをご利用の場合、受信制限・フィルタ設定をご確認ください
                  (情シス担当者への確認が必要な場合があります)。
                </li>
                <li>
                  上記でも届かない場合は、下記の「メールを再送する」ボタンからご再送いただくか、
                  運営までお問い合わせください。
                </li>
              </ol>
            </div>

            {/* 3. 再送ボタン + 状態表示 */}
            <div className="space-y-2">
              {resendStatus !== 'idle' && resendMessage && (
                <p
                  className={`rounded-md p-2 text-sm ${
                    resendStatus === 'success'
                      ? 'bg-success/10 text-success'
                      : resendStatus === 'rate_limited' || resendStatus === 'failed'
                        ? 'bg-destructive/10 text-destructive'
                        : 'bg-muted text-muted-foreground'
                  }`}
                  data-testid="resend-status"
                >
                  {resendStatus === 'success' && `✅ ${resendMessage}`}
                  {resendStatus === 'rate_limited' && `⚠️ ${resendMessage}`}
                  {resendStatus === 'failed' && `❌ ${resendMessage}`}
                  {resendStatus === 'sending' && resendMessage}
                </p>
              )}
              <Button
                type="button"
                variant="outline"
                className="w-full"
                onClick={handleResend}
                disabled={resendStatus === 'sending' || resendCooldownSec > 0}
                data-testid="resend-button"
              >
                {resendStatus === 'sending'
                  ? '再送中...'
                  : resendCooldownSec > 0
                    ? `メールを再送する (${resendCooldownSec} 秒後に再操作可)`
                    : resendCount > 0
                      ? `メールを再送する (再送済 ${resendCount} 回)`
                      : 'メールを再送する'}
              </Button>
            </div>

            {/* 4. 最終的に解決しない場合の運営お問い合わせ動線 */}
            <div className="rounded-md border border-muted-foreground/20 bg-muted/30 p-3 text-sm">
              <p className="m-0 font-semibold">それでも解決しない場合</p>
              <p className="m-0 mt-1 text-muted-foreground">
                以下のお問い合わせフォームより、運営までご連絡ください。お問い合わせ種別は
                <span className="font-semibold"> 「たすきばに関するお問い合わせ」</span>
                を選択してください。
              </p>
              <a
                href="https://teppei19980914.github.io/HomePage/ja/contact/"
                target="_blank"
                rel="noopener noreferrer"
                className="mt-2 inline-block text-info hover:underline"
                data-testid="contact-link"
              >
                お問い合わせフォームを開く (新しいタブで開きます) ↗
              </a>
            </div>

            <Link
              href="/login"
              className="inline-flex h-9 w-full items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-xs hover:bg-primary/90"
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
            新規テナント (組織) を開設します。プランをご選択ください。<strong>Beginner</strong>{' '}
            は 90 日試用 (プロジェクト作成・更新が月 50 回まで無料)、期限後は読み取り専用モードに移行します
            (データのエクスポート機能は引き続きご利用いただけます)。
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

            {/* ADR-0016 Revised (2026-05-22): 層 1 (signupAllowed=false) のとき
                = 入力された初期管理者メールが既に自前テナント保有ユーザ。公開フォーム不可。
                admin (Discord) 問合せ動線を強調表示し、submit を disable する。 */}
            {!signupAllowed && (
              <div
                className="rounded-md border border-warning/40 bg-warning/10 p-4 text-sm"
                data-testid="owned-tenant-warning"
              >
                <p className="font-semibold">
                  既に自前テナントを保有しているメールアドレスです
                </p>
                <p className="mt-1 text-muted-foreground">
                  {eligibilityHint ||
                    '入力された初期管理者メールは、既に自前テナントを保有しているユーザのものです。追加のテナント払い出しはシステム管理者へお問い合わせください。'}
                </p>
                {discordUrl && (
                  <p className="mt-2">
                    <a
                      href={discordUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-info hover:underline"
                    >
                      Discord でシステム管理者に問い合わせる
                    </a>
                  </p>
                )}
              </div>
            )}

            {/* ADR-0016 (2026-05-20): プラン選択 UI。Beginner は初回ユーザ限定 (90日試用 abuse 防止)。
                既登録 email の場合は Beginner radio を disable し Expert/Pro 必須にする。 */}
            <fieldset className="space-y-3 rounded border p-4">
              <legend className="px-1 text-sm font-semibold">プラン選択 *</legend>
              <div className="grid gap-2 sm:grid-cols-3">
                <label
                  className={`flex cursor-pointer items-start gap-2 rounded border p-3 text-sm ${
                    form.plan === 'beginner'
                      ? 'border-primary bg-primary/5'
                      : 'border-input hover:bg-muted/40'
                  } ${beginnerAvailable === false ? 'cursor-not-allowed opacity-50' : ''}`}
                >
                  <input
                    type="radio"
                    name="plan"
                    value="beginner"
                    checked={form.plan === 'beginner'}
                    onChange={() => setForm({ ...form, plan: 'beginner' })}
                    disabled={beginnerAvailable === false}
                    className="mt-0.5"
                  />
                  <div>
                    <div className="font-semibold">Beginner</div>
                    <div className="text-xs text-muted-foreground">90日試用 / 月50call / 5席</div>
                  </div>
                </label>
                <label
                  className={`flex cursor-pointer items-start gap-2 rounded border p-3 text-sm ${
                    form.plan === 'expert' ? 'border-primary bg-primary/5' : 'border-input hover:bg-muted/40'
                  }`}
                >
                  <input
                    type="radio"
                    name="plan"
                    value="expert"
                    checked={form.plan === 'expert'}
                    onChange={() => setForm({ ...form, plan: 'expert' })}
                    className="mt-0.5"
                  />
                  <div>
                    <div className="font-semibold">Expert</div>
                    <div className="text-xs text-muted-foreground">¥10/call 従量課金</div>
                  </div>
                </label>
                <label
                  className={`flex cursor-pointer items-start gap-2 rounded border p-3 text-sm ${
                    form.plan === 'pro' ? 'border-primary bg-primary/5' : 'border-input hover:bg-muted/40'
                  }`}
                >
                  <input
                    type="radio"
                    name="plan"
                    value="pro"
                    checked={form.plan === 'pro'}
                    onChange={() => setForm({ ...form, plan: 'pro' })}
                    className="mt-0.5"
                  />
                  <div>
                    <div className="font-semibold">Pro</div>
                    <div className="text-xs text-muted-foreground">¥15/call 高精度モデル</div>
                  </div>
                </label>
              </div>
              {beginnerAvailable === false && eligibilityHint && (
                <p
                  className="rounded-md bg-info/10 p-2 text-xs text-info"
                  data-testid="beginner-unavailable-hint"
                >
                  ℹ {eligibilityHint}
                </p>
              )}
            </fieldset>

            <fieldset className="space-y-3 rounded border p-4">
              <legend className="px-1 text-sm font-semibold">テナント (組織) 情報</legend>
              <div className="space-y-1.5">
                <Label htmlFor="name">表示用テナント名 *</Label>
                <Input id="name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={100} required />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="slug">組織 ID *</Label>
                {/* 2026-05-20: dash を [文字クラス先頭] に移動 (= Chrome v flag 互換、SyntaxError 回避) */}
                <Input id="slug" value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value.toLowerCase() })} placeholder="例: my-company" pattern="[a-z0-9](?:[-a-z0-9]{1,58}[a-z0-9])?" required />
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

            {/* feat/legal-pages-lp-integration (2026-05-21):
                規約・プラポリ同意。両方必須 (= submit ボタンが disabled)。
                LP の外部 URL を新タブで開かせる (target="_blank" + rel="noopener noreferrer")。
                同意の証跡 (民法 548 条の 2 / 定型約款の組入合意) は
                サーバ側 tenant-onboarding.service が TenantConsentLog テーブルに記録する。 */}
            <fieldset className="space-y-2 rounded border p-4">
              <legend className="px-1 text-sm font-semibold">同意事項 *</legend>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={form.acceptedTerms}
                  onChange={(e) => setForm({ ...form, acceptedTerms: e.target.checked })}
                  required
                  data-testid="signup-accept-terms"
                />
                <span>
                  <a
                    href={TERMS_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-info hover:underline"
                  >
                    利用規約
                  </a>
                  に同意します
                </span>
              </label>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={form.acceptedPrivacy}
                  onChange={(e) => setForm({ ...form, acceptedPrivacy: e.target.checked })}
                  required
                  data-testid="signup-accept-privacy"
                />
                <span>
                  <a
                    href={PRIVACY_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-info hover:underline"
                  >
                    プライバシーポリシー
                  </a>
                  に同意します
                </span>
              </label>
            </fieldset>

            <Button
              type="submit"
              className="w-full"
              disabled={
                submitting ||
                !form.acceptedTerms ||
                !form.acceptedPrivacy ||
                // ADR-0016 Revised (2026-05-22): 層 1 = 公開フォーム完全不可
                !signupAllowed
              }
              data-testid="signup-submit"
            >
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
