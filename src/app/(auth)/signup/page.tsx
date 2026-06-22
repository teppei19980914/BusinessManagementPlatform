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
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { TERMS_URL, PRIVACY_URL } from '@/config/legal-versions';
import { getDiscordInviteUrl } from '@/config/community';

type FormState = {
  name: string;
  // feat/signup-friction-reduction (2026-06-12): 組織 ID (slug) はサーバが自動採番するため
  //   フォームでは入力させない (FormState から削除)。採番値は送信成功時に assignedSlug で受ける。
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
  const t = useTranslations('auth');
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

  // feat/signup-friction-reduction (2026-06-12): 組織 ID (slug) はサーバが自動採番する。
  //   送信成功時にレスポンスの slug を受け取り、成功画面の表示 + 招待メール再送に使う。
  const [assignedSlug, setAssignedSlug] = useState('');

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
          // feat/signup-friction-reduction (2026-06-12): slug はサーバ自動採番。
          //   送信成功時に受け取った assignedSlug を再送に使う。
          tenantSlug: assignedSlug,
        }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        data?: { message?: string };
        error?: { code?: string; message?: string };
      };
      if (res.ok) {
        setResendStatus('success');
        setResendCount((c) => c + 1);
        setResendMessage(json.data?.message ?? t('signup.resendSuccessMessage'));
        // UX 上、再送直後の連打防止に 60 秒のフロント側クールダウンを設ける
        // (= サーバ側 Rate Limit とは独立、操作ミス防止が目的)
        setResendCooldownSec(60);
      } else if (res.status === 429) {
        setResendStatus('rate_limited');
        setResendMessage(json.error?.message ?? t('signup.resendRateLimitedMessage'));
        // Retry-After ヘッダがあれば優先、なければ 1 時間表示
        const retryAfter = res.headers.get('Retry-After');
        setResendCooldownSec(retryAfter ? parseInt(retryAfter, 10) : 3600);
      } else {
        setResendStatus('failed');
        setResendMessage(json.error?.message ?? t('signup.resendFailedMessage'));
      }
    } catch {
      setResendStatus('failed');
      setResendMessage(t('signup.resendNetworkError'));
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
      // feat/billing-conditional-by-plan (2026-06-05): Beginner は請求先セクション非表示のため、
      //   請求先担当者名・メールは初期管理者の値を流用し、billingType は individual 固定、
      //   住所サブフィールドは未送信 (undefined) にする。空文字 '' を送ると postalCode の regex
      //   検証に引っかかるため、必ず undefined にする (zod 側は optional)。
      const isBeginner = form.plan === 'beginner';
      const payload = {
        ...form,
        billingType: isBeginner ? 'individual' : form.billingType,
        billingCompanyName: isBeginner
          ? undefined
          : form.billingType === 'individual'
            ? undefined
            : form.billingCompanyName,
        billingContactName: isBeginner ? form.initialAdminName : form.billingContactName,
        billingContactEmail: isBeginner ? form.initialAdminEmail : form.billingContactEmail,
        billingPostalCode: isBeginner ? undefined : form.billingPostalCode,
        billingPrefecture: isBeginner ? undefined : form.billingPrefecture,
        billingCity: isBeginner ? undefined : form.billingCity,
        billingStreetAddress: isBeginner ? undefined : form.billingStreetAddress,
        billingBuildingName: isBeginner ? undefined : form.billingBuildingName.trim() || undefined,
        billingPhoneNumber: isBeginner ? undefined : form.billingPhoneNumber.trim() || undefined,
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
        // feat/signup-friction-reduction (2026-06-12): 組織 ID はサーバ自動採番のため、
        //   ユーザが入力欄で直す導線は無い。採番衝突はサーバ側で message を返す。
        if (code === 'SLUG_CONFLICT') setError(message ?? t('signup.errorSlugConflict'));
        // ADR-0016 (2026-05-20): EMAIL_CONFLICT は廃止 (tenant-scoped 一意化で発生不能)
        // ADR-0016 Revised (2026-05-22): 3 層判定のサーバ側 defense-in-depth エラー
        else if (code === 'OWNED_TENANT_EXISTS') setError(message ?? t('signup.errorOwnedTenant'));
        else if (code === 'BEGINNER_REQUIRES_UPGRADE') setError(message ?? t('signup.errorBeginnerUpgrade'));
        else if (code === 'EMAIL_SEND_FAILED') setError(t('signup.errorEmailSendFailed'));
        else if (code === 'RATE_LIMITED') setError(t('signup.errorRateLimited'));
        else setError(message ?? t('signup.errorDefault'));
        return;
      }

      // feat/signup-friction-reduction (2026-06-12): サーバが採番した組織 ID を保持し、
      //   成功画面の表示 + 招待メール再送に使う。
      setAssignedSlug((json?.data?.slug as string | undefined) ?? '');
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
            <CardTitle>{t('signup.successTitle')}</CardTitle>
            <CardDescription>{t('signup.successDescription')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            {/* 1. 入力メールアドレスの明示表示 (= typo 確認誘導) */}
            <div className="rounded-md border border-info/30 bg-info/5 p-3 text-sm">
              <p className="m-0 text-muted-foreground">{t('signup.successSendToLabel')}</p>
              <p
                className="m-0 mt-1 font-mono text-base break-all"
                data-testid="signup-success-email"
              >
                {form.initialAdminEmail}
              </p>
              <p className="m-0 mt-2 text-xs text-muted-foreground">
                {t('signup.successAddressErrorHint')}
              </p>
            </div>

            {/* feat/signup-friction-reduction (2026-06-12): 自動採番された組織 ID を明示する。
                組織 ID はログイン時に入力する値であり、招待メールにも記載される。入力欄を無くした分、
                ここで確実に本人へ伝える。 */}
            {assignedSlug && (
              <div
                className="rounded-md border border-info/30 bg-info/5 p-3 text-sm"
                data-testid="signup-success-slug-block"
              >
                <p className="m-0 text-muted-foreground">{t('signup.successSlugLabel')}</p>
                <p
                  className="m-0 mt-1 font-mono text-lg font-bold break-all"
                  data-testid="signup-success-slug"
                >
                  {assignedSlug}
                </p>
                <p className="m-0 mt-2 text-xs text-muted-foreground">
                  {t('signup.successSlugMemo')}
                </p>
              </div>
            )}

            {/* feat/signup-friction-reduction (2026-06-12): メール「予告」ブロック。
                送信後にアプリを離れてメールを探す段階で離脱しないよう、差出人・件名・到着目安・
                次の手順を **届く前に** 明示する。差出人/件名は実メール (email-verification.service.ts)
                と一致させること。届かなかった後のリカバリ (再送/チェックリスト) は下部に分離。 */}
            <div
              className="space-y-2 rounded-md border border-muted-foreground/20 bg-muted/30 p-3 text-sm"
              data-testid="signup-email-expectation"
            >
              <p className="m-0 font-semibold">{t('signup.emailExpectationTitle')}</p>
              <ul className="m-0 ml-4 list-disc space-y-1 text-muted-foreground">
                <li>
                  {t('signup.emailSenderPrefix')}<span className="font-mono">noreply@tasukiba.com</span>
                </li>
                <li>
                  {t('signup.emailSubjectPrefix')}<span className="font-semibold">{t('signup.emailSubjectValue')}</span>
                </li>
                <li>{t('signup.emailArrivalLine')}</li>
                <li>{t('signup.emailValidLine')}</li>
              </ul>
              <p className="m-0 mt-1 text-muted-foreground">{t('signup.emailNextSteps')}</p>
            </div>

            {/* 2. トラブルシュートチェックリスト */}
            <div className="space-y-2">
              <p className="text-sm font-semibold">{t('signup.troubleshootTitle')}</p>
              <ol className="ml-5 list-decimal space-y-1 text-sm text-muted-foreground">
                <li>{t('signup.troubleshootStep1')}</li>
                <li>{t('signup.troubleshootStep2')}</li>
                <li>{t('signup.troubleshootStep3')}</li>
                <li>{t('signup.troubleshootStep4')}</li>
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
                  ? t('signup.resendSending')
                  : resendCooldownSec > 0
                    ? t('signup.resendCooldown', { remaining: resendCooldownSec })
                    : resendCount > 0
                      ? t('signup.resendWithCount', { count: resendCount })
                      : t('signup.resendDefault')}
              </Button>
            </div>

            {/* 4. 最終的に解決しない場合の運営お問い合わせ動線 */}
            <div className="rounded-md border border-muted-foreground/20 bg-muted/30 p-3 text-sm">
              <p className="m-0 font-semibold">{t('signup.resolveTitle')}</p>
              <p className="m-0 mt-1 text-muted-foreground">
                {t('signup.resolveDescription')}
                <span className="font-semibold"> {t('signup.resolveContactKind')}</span>
                {t('signup.resolveContactKindPost')}
              </p>
              <a
                href="https://teppei19980914.github.io/HomePage/ja/contact/"
                target="_blank"
                rel="noopener noreferrer"
                className="mt-2 inline-block text-info hover:underline"
                data-testid="contact-link"
              >
                {t('signup.contactLink')}
              </a>
            </div>

            <Link
              href="/login"
              className="inline-flex h-9 w-full items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-xs hover:bg-primary/90"
            >
              {t('toLoginScreen')}
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
          <CardTitle>{t('signup.pageTitle')}</CardTitle>
          <CardDescription>
            {t('signup.pageDescriptionPre')}<strong>{t('signup.pageDescriptionBeginnerLabel')}</strong>{t('signup.pageDescriptionPost')}
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
                <p className="font-semibold">{t('signup.ownedTenantTitle')}</p>
                <p className="mt-1 text-muted-foreground">
                  {eligibilityHint || t('signup.ownedTenantFallback')}
                </p>
                {discordUrl && (
                  <p className="mt-2">
                    <a
                      href={discordUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-info hover:underline"
                    >
                      {t('signup.ownedTenantDiscordLink')}
                    </a>
                  </p>
                )}
              </div>
            )}

            {/* feat/signup-friction-reduction (2026-06-12): 心理的負荷低減のためセクション順を
                「組織情報 → 初期管理者 → プラン選択 → (Expert/Pro) 請求先」に変更。
                メール (initialAdminEmail) をプラン選択より前に入力させることで、3 層 eligibility
                判定 (層1 全面不可の警告 / 層2 Beginner disable) がプラン選択時点で確定する。 */}

            <fieldset className="space-y-3 rounded border p-4">
              <legend className="px-1 text-sm font-semibold">{t('signup.orgInfoLegend')}</legend>
              <div className="space-y-1.5">
                <Label htmlFor="name">{t('signup.orgNameLabel')}</Label>
                <Input id="name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={100} placeholder={t('signup.orgNamePlaceholder')} required />
              </div>
              {/* feat/signup-friction-reduction (2026-06-12): 組織 ID (ログイン時に使う識別子) は
                  サーバが数字連番で自動採番するため入力欄なし。採番値は送信後の成功画面と招待メールで案内する。 */}
              <p className="text-xs text-muted-foreground" data-testid="signup-org-id-auto-note">
                {t('signup.orgIdAutoNote')}
              </p>
            </fieldset>

            <fieldset className="space-y-3 rounded border p-4">
              <legend className="px-1 text-sm font-semibold">{t('signup.adminLegend')}</legend>
              <p className="text-xs text-muted-foreground">{t('signup.adminLegendHint')}</p>
              <div className="space-y-1.5">
                <Label htmlFor="initialAdminName">{t('signup.adminNameLabel')}</Label>
                <Input id="initialAdminName" value={form.initialAdminName} onChange={(e) => setForm({ ...form, initialAdminName: e.target.value })} maxLength={100} required />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="initialAdminEmail">{t('signup.adminEmailLabel')}</Label>
                <Input id="initialAdminEmail" type="email" value={form.initialAdminEmail} onChange={(e) => setForm({ ...form, initialAdminEmail: e.target.value })} maxLength={255} required />
              </div>
            </fieldset>

            {/* ADR-0016 (2026-05-20): プラン選択 UI。Beginner は初回ユーザ限定 (90日試用 abuse 防止)。
                既登録 email の場合は Beginner radio を disable し Expert/Pro 必須にする。 */}
            <fieldset className="space-y-3 rounded border p-4">
              <legend className="px-1 text-sm font-semibold">{t('signup.planLegend')}</legend>
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
                    <div className="text-xs text-muted-foreground">{t('signup.planBeginnerDesc')}</div>
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
                    <div className="text-xs text-muted-foreground">{t('signup.planExpertDesc')}</div>
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
                    <div className="text-xs text-muted-foreground">{t('signup.planProDesc')}</div>
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

            {/* feat/billing-conditional-by-plan (2026-06-05): Beginner は課金が発生しないため請求先セクションを
                非表示にし、心理的ハードルを下げる。請求先担当者名・メールは送信時に初期管理者の値を流用し、
                billingType は individual 固定で送る (handleSubmit 参照)。Expert/Pro のみ請求先を入力・必須化する。 */}
            {form.plan !== 'beginner' && (
            <fieldset className="space-y-3 rounded border p-4">
              <legend className="px-1 text-sm font-semibold">{t('signup.billingLegend')}</legend>

              {/* 既登録メールで Beginner → Expert に自動切替された場合 (層 2)、請求先が必要になった理由を明示。 */}
              {beginnerAvailable === false && (
                <p
                  className="rounded-md bg-info/10 p-2 text-xs text-info"
                  data-testid="billing-required-on-upgrade-hint"
                >
                  {t('signup.billingUpgradeHint')}
                </p>
              )}

              {/* 2026-05-09 (PR C / #5): 個人 / 法人 切替 */}
              <div className="space-y-1.5">
                <Label>{t('signup.billingTypeLabel')}</Label>
                <div className="flex gap-4 text-sm">
                  <label className="flex items-center gap-1.5">
                    <input
                      type="radio"
                      name="billingType"
                      value="corporate"
                      checked={form.billingType === 'corporate'}
                      onChange={() => setForm({ ...form, billingType: 'corporate' })}
                    />
                    {t('signup.billingTypeCorporate')}
                  </label>
                  <label className="flex items-center gap-1.5">
                    <input
                      type="radio"
                      name="billingType"
                      value="individual"
                      checked={form.billingType === 'individual'}
                      onChange={() => setForm({ ...form, billingType: 'individual', billingCompanyName: '' })}
                    />
                    {t('signup.billingTypeIndividual')}
                  </label>
                </div>
              </div>

              {/* 2026-05-09 (#5): 法人選択時のみ会社名を表示・必須 */}
              {form.billingType === 'corporate' && (
                <div className="space-y-1.5">
                  <Label htmlFor="billingCompanyName">{t('signup.billingCompanyLabel')}</Label>
                  <Input id="billingCompanyName" value={form.billingCompanyName} onChange={(e) => setForm({ ...form, billingCompanyName: e.target.value })} maxLength={200} required />
                </div>
              )}

              <div className="space-y-1.5">
                <Label htmlFor="billingContactName">
                  {form.billingType === 'corporate' ? t('signup.billingContactNameCorporate') : t('signup.billingContactNameIndividual')}
                </Label>
                <Input id="billingContactName" value={form.billingContactName} onChange={(e) => setForm({ ...form, billingContactName: e.target.value })} maxLength={100} required />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="billingContactEmail">{t('signup.billingEmailLabel')}</Label>
                <Input id="billingContactEmail" type="email" value={form.billingContactEmail} onChange={(e) => setForm({ ...form, billingContactEmail: e.target.value })} maxLength={255} required />
              </div>

              {/* 2026-05-09 (PR C / #8): 住所をサブフィールドに分割 */}
              <div className="space-y-1.5">
                <Label htmlFor="billingPostalCode">{t('signup.billingPostalCodeLabel')}</Label>
                <Input
                  id="billingPostalCode"
                  value={form.billingPostalCode}
                  onChange={(e) => setForm({ ...form, billingPostalCode: e.target.value })}
                  maxLength={10}
                  placeholder={t('signup.billingPostalCodePlaceholder')}
                  pattern="\d{3}-?\d{4}"
                  required
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="billingPrefecture">{t('signup.billingPrefectureLabel')}</Label>
                  <Input id="billingPrefecture" value={form.billingPrefecture} onChange={(e) => setForm({ ...form, billingPrefecture: e.target.value })} maxLength={20} placeholder={t('signup.billingPrefecturePlaceholder')} required />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="billingCity">{t('signup.billingCityLabel')}</Label>
                  <Input id="billingCity" value={form.billingCity} onChange={(e) => setForm({ ...form, billingCity: e.target.value })} maxLength={100} placeholder={t('signup.billingCityPlaceholder')} required />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="billingStreetAddress">{t('signup.billingStreetLabel')}</Label>
                <Input id="billingStreetAddress" value={form.billingStreetAddress} onChange={(e) => setForm({ ...form, billingStreetAddress: e.target.value })} maxLength={200} placeholder={t('signup.billingStreetPlaceholder')} required />
              </div>
              {/* 2026-05-09 (#10): 建物名・部屋番号は任意 */}
              <div className="space-y-1.5">
                <Label htmlFor="billingBuildingName">{t('signup.billingBuildingLabel')}</Label>
                <Input id="billingBuildingName" value={form.billingBuildingName} onChange={(e) => setForm({ ...form, billingBuildingName: e.target.value })} maxLength={200} placeholder={t('signup.billingBuildingPlaceholder')} />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="billingPhoneNumber">{t('signup.billingPhoneLabel')}</Label>
                <Input id="billingPhoneNumber" value={form.billingPhoneNumber} onChange={(e) => setForm({ ...form, billingPhoneNumber: e.target.value })} maxLength={20} placeholder={t('signup.billingPhonePlaceholder')} />
              </div>
            </fieldset>
            )}

            {/* feat/legal-pages-lp-integration (2026-05-21):
                規約・プラポリ同意。両方必須 (= submit ボタンが disabled)。
                LP の外部 URL を新タブで開かせる (target="_blank" + rel="noopener noreferrer")。
                同意の証跡 (民法 548 条の 2 / 定型約款の組入合意) は
                サーバ側 tenant-onboarding.service が TenantConsentLog テーブルに記録する。 */}
            <fieldset className="space-y-2 rounded border p-4">
              <legend className="px-1 text-sm font-semibold">{t('signup.consentLegend')}</legend>
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
                    {t('signup.consentTermsLinkText')}
                  </a>
                  {t('signup.consentPost')}
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
                    {t('signup.consentPrivacyLinkText')}
                  </a>
                  {t('signup.consentPost')}
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
              {submitting ? t('signup.submittingButton') : t('signup.submitButton')}
            </Button>

            <p className="text-center text-sm text-muted-foreground">
              {t('signup.alreadyHaveAccountPre')}<Link href="/login" className="text-info hover:underline">{t('signup.alreadyHaveAccountLink')}</Link>{t('signup.alreadyHaveAccountPost')}
            </p>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
