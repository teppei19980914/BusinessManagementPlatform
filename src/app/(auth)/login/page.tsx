'use client';

import { Suspense, useEffect, useState } from 'react';
import { signIn } from 'next-auth/react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { sanitizeCallbackUrl } from '@/lib/url-utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
// PR #117: JST 固定タイムゾーン描画 (ハイドレーション安全)
import { formatDateTimeFull } from '@/lib/format';
// PR #420 補足: localStorage 由来のテナント履歴 (LRU 5 件, 90 日 expire)
import {
  getTenantHistory,
  recordTenantUsage,
  clearTenantHistory,
  type TenantHistoryEntry,
} from '@/lib/tenant-history';

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const t = useTranslations('auth');
  const searchParams = useSearchParams();
  // PR #198: CWE-601 オープンリダイレクト対策。外部 URL / スキーマ相対 URL は拒否し、
  //   同一オリジンパスのみ許可する (詳細は src/lib/url-utils.ts)。
  const callbackUrl = sanitizeCallbackUrl(searchParams.get('callbackUrl'));
  // ADR-0016 (2026-05-20): tenantSlug を URL クエリから初期値取得 (= メールリンク経由のケース)
  const initialTenantSlug = searchParams.get('tenant') ?? '';
  const [tenantSlug, setTenantSlug] = useState(initialTenantSlug);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  // PR #420 補足: tenant 履歴を localStorage から読み込み datalist に提供
  const [tenantHistory, setTenantHistory] = useState<TenantHistoryEntry[]>([]);

  // 初回 mount 時に localStorage から履歴を読み込む。
  // URL クエリ ?tenant=xxx が無く、履歴がある場合は最新を初期値にセット。
  //
  // 注: SSR 中は localStorage が存在しないため useState 初期値では参照できず、
  //   client-side mount 後に setState で同期する必要がある (Next.js + localStorage の
  //   標準パターン)。cascading-render 警告は本ケースでは挙動上問題ない。
  useEffect(() => {
    const history = getTenantHistory();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTenantHistory(history);
    if (!initialTenantSlug && history.length > 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setTenantSlug(history[0].slug);
    }
    // 初回 mount でのみ実行 (input は以降ユーザ操作で変化)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setIsLoading(true);

    // fix/session-clearance (2026-05-20): signIn 前に旧 cookie を必ず破棄する (defense-in-depth)。
    //   Netlify で signOut の Set-Cookie が脱落して /login に旧 cookie が持ち越されている場合、
    //   このまま signIn すると新 cookie の Set-Cookie も脱落するシナリオで「他人になりすます」
    //   事故が発生しうる。先に explicit-signout で物理削除 + tokenVersion increment しておけば、
    //   仮に新 cookie が届かなくても最悪「ログイン失敗 → /login に戻される」で済む。
    //   詳細: KDD §5.X+72
    const clearRes = await fetch('/api/auth/explicit-signout', { method: 'POST' });
    if (!clearRes.ok) {
      setError('セッションのクリアに失敗しました。ページを再読み込みしてから再度お試しください。');
      setIsLoading(false);
      return;
    }

    const result = await signIn('credentials', {
      email,
      password,
      // ADR-0016 (2026-05-20): tenantSlug を credential として送信
      tenantSlug,
      redirect: false,
    });

    if (result?.error) {
      // PR #87: ログイン失敗時、ロック状態だったのかパスワード誤りだったのかを
      // 区別してメッセージを出し分ける。/api/auth/lock-status は存在しないメールでも
      // 'none' を返すため enumeration リスクはない (既に signIn 自体が同等情報を
      // 時間差で露出し得るのでネット差分はゼロ)。
      const lockRes = await fetch('/api/auth/lock-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // ADR-0016 (2026-05-20): multi-tenant 対応で tenantSlug を併送
        body: JSON.stringify({ email, tenantSlug }),
      }).catch(() => null);
      const lock = lockRes && lockRes.ok
        ? (await lockRes.json().catch(() => null) as
            | { status: 'permanent_lock' }
            | { status: 'temporary_lock'; unlockAt: string }
            | { status: 'inactive' }
            | { status: 'none' }
            | null)
        : null;

      if (lock?.status === 'permanent_lock') {
        setError(t('accountLocked'));
      } else if (lock?.status === 'temporary_lock') {
        // PR #117: JST 固定フォーマットで表示 (環境依存せず常に同じ表記)
        setError(t('temporaryLock', { unlockAt: formatDateTimeFull(lock.unlockAt) }));
      } else if (lock?.status === 'inactive') {
        // PR fix/login-failure (2026-05-03): 非活性アカウントを明示。
        //   これまで「パスワード間違い」と誤表示されて本人が原因に気付けない
        //   UX バグになっていた。
        setError(t('accountInactive'));
      } else {
        setError(t('invalidCredentials'));
      }
      setIsLoading(false);
      return;
    }

    // PR #420 補足: ログイン成功直後、認証済み状態で /api/auth/current-tenant-info を呼び、
    //   { slug, name } を localStorage の履歴 (LRU 5 件) に保存する。
    //   失敗しても本筋のリダイレクトを止めない (best-effort)。
    try {
      const infoRes = await fetch('/api/auth/current-tenant-info');
      if (infoRes.ok) {
        const json = (await infoRes.json()) as { data?: { slug?: string; name?: string } };
        const slug = json.data?.slug;
        const name = json.data?.name;
        if (slug && name) {
          recordTenantUsage(slug, name);
        }
      }
    } catch {
      /* noop: 履歴記録は best-effort */
    }

    setIsLoading(false);
    // フルページリロードで Cookie を確実に送信（Vercel 環境対応）。
    // PR #198: 二重に sanitize する (defense in depth)。callbackUrl は受け取り時点でも
    //   sanitize 済みだが、将来コードの近接箇所で外部由来の文字列が再代入されても
    //   オープンリダイレクトに退行しないよう、リダイレクト直前にも検証する。
    window.location.href = sanitizeCallbackUrl(callbackUrl);
  }

  function handleClearHistory() {
    const confirmed = window.confirm(
      t('tenantHistoryClearConfirm', { count: tenantHistory.length }),
    );
    if (!confirmed) return;
    clearTenantHistory();
    setTenantHistory([]);
  }

  return (
    <div className="flex flex-1 items-center justify-center bg-muted px-4 py-8">
      <Card className="w-full max-w-[min(90vw,28rem)]">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl" data-testid="auth-app-name-title">{t('appName')}</CardTitle>
          <CardDescription>Knowledge Relay</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            {error && (
              <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>
            )}
            {/* ADR-0016 (2026-05-20): 組織 ID (= tenantSlug) を入力。
                同じメールアドレスが複数の組織に所属しうるため、
                どの組織にログインするかをここで指定する。
                メールリンク経由のサインアップ/招待では URL クエリ `?tenant=...` から
                初期値が自動入力される。
                PR #420 補足: localStorage に過去ログイン成功した組織を最大 5 件 LRU 保存し、
                <datalist> で候補表示する。pre-auth で server に slug→name 問合せは行わず、
                ログイン成功直後の /api/auth/current-tenant-info で初めて name を取得する。 */}
            <div className="space-y-2">
              <Label htmlFor="tenantSlug">{t('tenantSlugLabel')}</Label>
              <Input
                id="tenantSlug"
                type="text"
                value={tenantSlug}
                onChange={(e) => setTenantSlug(e.target.value)}
                placeholder={t('tenantSlugPlaceholder')}
                required
                autoComplete="organization"
                list={tenantHistory.length > 0 ? 'tenant-history' : undefined}
              />
              {/* PR #420 補足: 直近 5 件の組織を datalist で候補表示。
                  保存される値は slug + name + lastUsedAt のみ (credentials/UUID 一切なし)。
                  React JSX のテキストノード経由なので XSS 安全。 */}
              {tenantHistory.length > 0 && (
                <datalist id="tenant-history" aria-label={t('tenantHistoryListLabel')}>
                  {tenantHistory.map((entry) => (
                    <option key={entry.slug} value={entry.slug}>
                      {entry.name}
                    </option>
                  ))}
                </datalist>
              )}
              <p className="text-xs text-muted-foreground">
                {t('tenantSlugHint')}
              </p>
              {/* L3.5: 組織 ID 不明時の案内 (常に表示) */}
              <p className="text-xs text-muted-foreground">
                {t('tenantSlugUnknownHint')}
              </p>
              {/* PR #420 補足: 履歴がある場合のみ「クリア」リンク + 共用 PC 注意喚起 */}
              {tenantHistory.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  <button
                    type="button"
                    onClick={handleClearHistory}
                    className="text-info hover:underline"
                  >
                    {t('tenantHistoryClearLink')}
                  </button>
                  <span className="ml-2">{t('tenantHistorySharedPcWarn')}</span>
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="email">{t('email')}</Label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="admin@example.com"
                required
                autoComplete="email"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">{t('password')}</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="current-password"
              />
            </div>
            <Button type="submit" className="w-full" disabled={isLoading}>
              {isLoading ? t('loginInProgress') : t('loginButton')}
            </Button>
            <p className="text-center text-xs text-muted-foreground">
              <a href="/reset-password" className="text-info hover:underline">
                {t('forgotPassword')}
              </a>
            </p>
            {/* P-G (2026-05-08): セルフサインアップ導線 */}
            <p className="text-center text-xs text-muted-foreground">
              新規組織でご利用ですか?{' '}
              <a href="/signup" className="text-info hover:underline">
                サインアップ
              </a>
            </p>
          </form>
        </CardContent>
      </Card>

      {/*
       * 2026-05-19 (docs/2026-05-19-roadmap-archive): 初見訪問者向け案内 + フッタリンク。
       *   外部ユーザがログイン画面に直接到達した場合の案内導線を提示。
       * 2026-05-21 (feat/legal-pages-lp-integration): 利用規約・プラポリは外部 LP
       *   (HomePage / tasukiba-user.md) に集約。本サービス内の /terms /privacy ページは廃止。
       *   フッタリンクは LP の #terms / #privacy アンカーへ直接遷移する。
       */}
      <div
        data-testid="login-public-footer"
        className="mt-6 w-full max-w-[min(90vw,28rem)] text-center text-xs text-muted-foreground"
      >
        <p className="mb-2">
          本サービスは現在 <span className="font-semibold">招待制</span> です。
          ご興味のある方はお問い合わせください。
        </p>
        <p>
          <a
            href="https://teppei19980914.github.io/HomePage/ja/product/tasukiba-user/#terms"
            target="_blank"
            rel="noopener noreferrer"
            className="mx-2 hover:underline"
          >
            利用規約
          </a>
          <span aria-hidden="true">|</span>
          <a
            href="https://teppei19980914.github.io/HomePage/ja/product/tasukiba-user/#privacy"
            target="_blank"
            rel="noopener noreferrer"
            className="mx-2 hover:underline"
          >
            プライバシーポリシー
          </a>
        </p>
      </div>
    </div>
  );
}
