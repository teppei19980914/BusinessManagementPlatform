'use client';

/**
 * 初期パスワード設定画面 (PR #91 で admin 向け MFA 強制を追加)。
 *
 * フロー:
 *   1. パスワード入力 (step='password')
 *      → POST /api/auth/setup-password
 *      → admin なら requiresMfa=true + QR を受け取って step='mfa' へ
 *      → general なら recoveryCodes を受け取って step='done' へ
 *   2. MFA 登録 (step='mfa', admin のみ)
 *      → QR を表示、TOTP 6 桁入力
 *      → POST /api/auth/setup-mfa-initial
 *      → 成功時 step='done' (アカウント有効化される)
 *   3. リカバリーコード表示 (step='done')
 *      → ログイン画面へ誘導
 *
 * トークンは step 1 完了時点では未使用のまま保持され、step 2 成功で初めて使用済になる
 * (PR #91 仕様: 「password 設定 + MFA 有効化」の両方が揃わないと有効化されない)。
 */

import { Suspense, useState, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import Image from 'next/image';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export default function SetupPasswordPage() {
  return (
    <Suspense>
      <SetupPasswordForm />
    </Suspense>
  );
}

type Step = 'password' | 'mfa' | 'done';

type MfaData = {
  otpauthUri: string;
  qrCodeDataUrl: string;
};

function SetupPasswordForm() {
  const searchParams = useSearchParams();
  const token = searchParams.get('token') || '';

  // ---- UI state ----
  const [step, setStep] = useState<Step>('password');

  // step='password'
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [pwError, setPwError] = useState('');
  const [pwLoading, setPwLoading] = useState(false);

  // step='mfa' (admin のみ)
  const [mfaData, setMfaData] = useState<MfaData | null>(null);
  const [totpCode, setTotpCode] = useState('');
  const [mfaError, setMfaError] = useState('');
  const [mfaLoading, setMfaLoading] = useState(false);

  // step='done'
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);

  // トークン検証 (初期表示)
  const [tokenError, setTokenError] = useState('');
  const [isValidating, setIsValidating] = useState(true);

  useEffect(() => {
    if (!token) {
      setTokenError('無効なリンクです');
      setIsValidating(false);
      return;
    }

    fetch(`/api/auth/setup-password?token=${encodeURIComponent(token)}`)
      .then((res) => res.json())
      .then((json) => {
        if (json.error) {
          setTokenError(json.error.message);
        }
      })
      .catch(() => {
        setTokenError('トークンの検証に失敗しました');
      })
      .finally(() => {
        setIsValidating(false);
      });
  }, [token]);

  async function handlePasswordSubmit(e: React.FormEvent) {
    e.preventDefault();
    setPwError('');

    if (password !== confirmPassword) {
      setPwError('パスワードが一致しません');
      return;
    }

    setPwLoading(true);

    try {
      const res = await fetch('/api/auth/setup-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password, confirmPassword }),
      });

      const json = await res.json();

      if (!res.ok) {
        setPwError(
          json.error?.details?.[0]?.message
            || json.error?.message
            || 'パスワードの設定に失敗しました',
        );
        return;
      }

      // リカバリーコードは常に保持 (admin も general も表示対象)
      setRecoveryCodes(json.data.recoveryCodes);

      if (json.data.requiresMfa && json.data.mfa) {
        // admin: MFA 登録へ
        setMfaData(json.data.mfa);
        setStep('mfa');
      } else {
        // general: 即 done
        setStep('done');
      }
    } catch {
      setPwError('エラーが発生しました。しばらくしてから再度お試しください。');
    } finally {
      setPwLoading(false);
    }
  }

  async function handleMfaSubmit(e: React.FormEvent) {
    e.preventDefault();
    setMfaError('');
    setMfaLoading(true);

    try {
      const res = await fetch('/api/auth/setup-mfa-initial', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, code: totpCode }),
      });

      const json = await res.json();

      if (!res.ok) {
        setMfaError(
          json.error?.message || 'MFA 登録に失敗しました。コードを確認して再度お試しください。',
        );
        return;
      }

      // 成功: リカバリーコード表示画面へ (recoveryCodes は step=password で保持済)
      setStep('done');
    } catch {
      setMfaError('エラーが発生しました。しばらくしてから再度お試しください。');
    } finally {
      setMfaLoading(false);
    }
  }

  // ---- 画面表示 ----

  if (isValidating) {
    return (
      <Screen>
        <Card className="w-full max-w-[min(90vw,28rem)]">
          <CardContent className="py-8 text-center text-muted-foreground">
            確認中...
          </CardContent>
        </Card>
      </Screen>
    );
  }

  if (tokenError) {
    return (
      <Screen>
        <Card className="w-full max-w-[min(90vw,28rem)]">
          <CardHeader className="text-center">
            <CardTitle className="text-2xl">たすきば</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{tokenError}</div>
            <p className="text-center text-sm text-muted-foreground">
              管理者に新しい招待メールの再送を依頼してください。
            </p>
            <Button className="w-full" onClick={() => { window.location.href = '/login'; }}>
              ログイン画面へ
            </Button>
          </CardContent>
        </Card>
      </Screen>
    );
  }

  if (step === 'done' && recoveryCodes) {
    return (
      <Screen>
        <Card className="w-full max-w-[min(90vw,28rem)]">
          <CardHeader className="text-center">
            <CardTitle className="text-2xl">セットアップ完了</CardTitle>
            <CardDescription>
              アカウントが有効化されました。以下のリカバリーコードを安全な場所に保管してください。
              <strong className="block mt-1 text-destructive">このコードは再表示できません。</strong>
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-md bg-muted p-4 font-mono text-sm">
              {recoveryCodes.map((code, i) => (
                <div key={i}>
                  {String(i + 1).padStart(2, ' ')}. {code}
                </div>
              ))}
            </div>
            <Button className="w-full" onClick={() => { window.location.href = '/login'; }}>
              ログイン画面へ
            </Button>
          </CardContent>
        </Card>
      </Screen>
    );
  }

  if (step === 'mfa' && mfaData) {
    return (
      <Screen>
        <Card className="w-full max-w-[min(90vw,28rem)]">
          <CardHeader className="text-center">
            <CardTitle className="text-2xl">多要素認証の設定</CardTitle>
            <CardDescription>
              システム管理者アカウントは多要素認証 (MFA) が必須です。
              下の QR コードを認証アプリ (Google Authenticator 等) で読み取り、
              表示された 6 桁のコードを入力してアカウントを有効化してください。
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div className="flex justify-center rounded-md border border-input bg-background p-4">
                <Image
                  src={mfaData.qrCodeDataUrl}
                  alt="MFA QR コード"
                  width={200}
                  height={200}
                  unoptimized
                />
              </div>
              <details className="text-xs text-muted-foreground">
                <summary className="cursor-pointer">QR コードを読み取れない場合 (シークレット手動入力)</summary>
                <div className="mt-2 break-all rounded-md bg-muted p-2 font-mono">
                  {mfaData.otpauthUri}
                </div>
              </details>
              <form onSubmit={handleMfaSubmit} className="space-y-4">
                {mfaError && (
                  <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{mfaError}</div>
                )}
                <div className="space-y-2">
                  <Label htmlFor="totp">6 桁のコード</Label>
                  <Input
                    id="totp"
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]{6}"
                    maxLength={6}
                    value={totpCode}
                    onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, ''))}
                    required
                    autoComplete="one-time-code"
                  />
                </div>
                <Button type="submit" className="w-full" disabled={mfaLoading || totpCode.length !== 6}>
                  {mfaLoading ? '有効化中...' : '多要素認証を有効化してアカウントを有効化'}
                </Button>
              </form>
              <p className="text-xs text-muted-foreground">
                ※ この画面を閉じても、トークンの有効期限内であれば再度同じリンクから
                このステップに戻れます (パスワードは既に保存されています)。
              </p>
            </div>
          </CardContent>
        </Card>
      </Screen>
    );
  }

  // step === 'password' (default)
  return (
    <Screen>
      <Card className="w-full max-w-[min(90vw,28rem)]">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">たすきば</CardTitle>
          <CardDescription>パスワードを設定してアカウントを有効化します</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handlePasswordSubmit} className="space-y-4">
            {pwError && (
              <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{pwError}</div>
            )}
            <div className="space-y-2">
              <Label htmlFor="password">パスワード</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="new-password"
              />
              <p className="text-xs text-muted-foreground">
                10文字以上、英大文字・英小文字・数字・記号のうち3種以上
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="confirmPassword">パスワード（確認）</Label>
              <Input
                id="confirmPassword"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
                autoComplete="new-password"
              />
            </div>
            <Button type="submit" className="w-full" disabled={pwLoading}>
              {pwLoading ? '設定中...' : 'パスワードを設定'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </Screen>
  );
}

/** 共通の画面ラッパ (中央寄せ) */
function Screen({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-muted px-4">
      {children}
    </div>
  );
}
