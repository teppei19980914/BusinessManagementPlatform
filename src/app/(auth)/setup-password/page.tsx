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
import { useTranslations } from 'next-intl';
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
  const t = useTranslations('auth');
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
      setTokenError(t('invalidLink'));
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
        setTokenError(t('tokenVerifyFailed'));
      })
      .finally(() => {
        setIsValidating(false);
      });
  }, [token, t]);

  async function handlePasswordSubmit(e: React.FormEvent) {
    e.preventDefault();
    setPwError('');

    if (password !== confirmPassword) {
      setPwError(t('passwordMismatch'));
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
            || t('passwordSetFailed'),
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
      setPwError(t('errorRetry'));
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
          json.error?.message || t('mfaRegisterFailed'),
        );
        return;
      }

      // 成功: リカバリーコード表示画面へ (recoveryCodes は step=password で保持済)
      setStep('done');
    } catch {
      setMfaError(t('errorRetry'));
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
            {t('verifying')}
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
            <CardTitle className="text-2xl">{t('appName')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{tokenError}</div>
            <p className="text-center text-sm text-muted-foreground">
              {t('tokenInvalidContact')}
            </p>
            <Button className="w-full" onClick={() => { window.location.href = '/login'; }}>
              {t('toLoginScreen')}
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
            <CardTitle className="text-2xl">{t('setupComplete')}</CardTitle>
            <CardDescription>
              {t('setupCompleteHint')}
              <strong className="block mt-1 text-destructive">{t('recoveryCodeOnce')}</strong>
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
              {t('toLoginScreen')}
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
            <CardTitle className="text-2xl">{t('mfaSetupTitle')}</CardTitle>
            <CardDescription>
              {t('mfaSetupHint')}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div className="flex justify-center rounded-md border border-input bg-background p-4">
                <Image
                  src={mfaData.qrCodeDataUrl}
                  alt={t('mfaQrCode')}
                  width={200}
                  height={200}
                  unoptimized
                />
              </div>
              <details className="text-xs text-muted-foreground">
                <summary className="cursor-pointer">{t('mfaSecretManual')}</summary>
                <div className="mt-2 break-all rounded-md bg-muted p-2 font-mono">
                  {mfaData.otpauthUri}
                </div>
              </details>
              <form onSubmit={handleMfaSubmit} className="space-y-4">
                {mfaError && (
                  <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{mfaError}</div>
                )}
                <div className="space-y-2">
                  <Label htmlFor="totp">{t('sixDigitCode')}</Label>
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
                  {mfaLoading ? t('mfaActivating') : t('mfaActivate')}
                </Button>
              </form>
              <p className="text-xs text-muted-foreground">
                {t('mfaSetupNote')}
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
          <CardTitle className="text-2xl">{t('appName')}</CardTitle>
          <CardDescription>{t('setupSubtitle')}</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handlePasswordSubmit} className="space-y-4">
            {pwError && (
              <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{pwError}</div>
            )}
            <div className="space-y-2">
              <Label htmlFor="password">{t('password')}</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="new-password"
              />
              <p className="text-xs text-muted-foreground">
                {t('passwordHint')}
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="confirmPassword">{t('passwordConfirm')}</Label>
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
              {pwLoading ? t('settingPassword') : t('setPassword')}
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
