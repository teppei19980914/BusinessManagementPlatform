'use client';

/**
 * MFA 検証フォーム (PR #67 Client Component)。
 *
 * POST /api/auth/mfa/verify でコード検証 → 成功したら useSession().update()
 * で JWT を mfaVerified=true に更新し、callbackUrl へ遷移する。
 */

import { useState } from 'react';
import { useSession, signOut } from 'next-auth/react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { sanitizeCallbackUrl } from '@/lib/url-utils';

export function MfaForm({ userId, callbackUrl }: { userId: string; callbackUrl: string }) {
  const t = useTranslations('auth');
  const { update } = useSession();
  const [code, setCode] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setIsLoading(true);

    try {
      const body = useRecovery ? { userId, recoveryCode } : { userId, code };
      const res = await fetch('/api/auth/mfa/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        setError(json.error?.message || t('mfaInvalidCode'));
        return;
      }
      // JWT を mfaVerified=true で再発行 (auth.config.ts jwt callback の trigger='update' 経由)
      await update({ mfaVerified: true });
      // フルページリロードで最新 cookie を確実に送る (ログインと同じパターン)。
      // PR #198: callbackUrl は CWE-601 対策で sanitize してから遷移する。
      window.location.href = sanitizeCallbackUrl(callbackUrl);
    } finally {
      setIsLoading(false);
    }
  }

  async function handleCancel() {
    await signOut({ callbackUrl: '/login', redirect: true });
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted px-4">
      <Card className="w-full max-w-[min(90vw,28rem)]">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">{t('mfaTitle')}</CardTitle>
          <CardDescription>
            {t('mfaCodeHint')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            {error && (
              <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>
            )}
            {useRecovery ? (
              <div className="space-y-2">
                <Label htmlFor="recoveryCode">{t('recoveryCode')}</Label>
                <Input
                  id="recoveryCode"
                  value={recoveryCode}
                  onChange={(e) => setRecoveryCode(e.target.value)}
                  autoComplete="one-time-code"
                  required
                />
              </div>
            ) : (
              <div className="space-y-2">
                <Label htmlFor="code">{t('verificationCode')}</Label>
                <Input
                  id="code"
                  inputMode="numeric"
                  pattern="\d{6}"
                  maxLength={6}
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                  placeholder="123456"
                  autoComplete="one-time-code"
                  required
                />
              </div>
            )}
            <Button type="submit" className="w-full" disabled={isLoading}>
              {isLoading ? t('mfaVerifying') : t('mfaVerify')}
            </Button>
            <div className="flex justify-between text-xs">
              <button
                type="button"
                className="text-info hover:underline"
                onClick={() => {
                  setUseRecovery(!useRecovery);
                  setError('');
                }}
              >
                {useRecovery ? t('mfaUseAuthCode') : t('mfaUseRecoveryCode')}
              </button>
              <button
                type="button"
                className="text-muted-foreground hover:underline"
                onClick={handleCancel}
              >
                {t('signOut')}
              </button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
