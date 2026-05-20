'use client';

/**
 * MFA 検証フォーム (PR #67 Client Component)。
 *
 * POST /api/auth/mfa/verify でコード検証 → 成功すると API 側で **JWT を再署名 + Set-Cookie**
 * (fix/jwt-resign-for-netlify、2026-05-18 以降) → callbackUrl へフルページ遷移して反映。
 *
 * 旧仕様は `useSession().update({ mfaVerified: true })` 経由で JWT を更新していたが、
 * NextAuth v5 + @netlify/plugin-nextjs では update() の Set-Cookie が反映されず MFA ループに
 * 陥る事象を確認したため、サーバ側でのみ JWT 再署名する設計に変更した。
 * 詳細: src/app/api/auth/mfa/verify/route.ts / src/lib/auth-jwt-helper.ts
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { sanitizeCallbackUrl } from '@/lib/url-utils';

export function MfaForm({ userId, callbackUrl }: { userId: string; callbackUrl: string }) {
  const t = useTranslations('auth');
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
      // JWT は API 側で mfaVerified=true に再署名済 + Set-Cookie 完了。
      // フルページ遷移で新 cookie を確実に送り、middleware の MFA gate を通過する。
      // PR #198: callbackUrl は CWE-601 対策で sanitize してから遷移する。
      window.location.href = sanitizeCallbackUrl(callbackUrl);
    } finally {
      setIsLoading(false);
    }
  }

  async function handleCancel() {
    // fix/session-clearance (2026-05-20): NextAuth 既定 signOut の Set-Cookie 脱落対策。
    //   自前 route で tokenVersion increment + cookie 削除 → フルリロードで /login に遷移。
    //   詳細: KDD §5.X+72
    await fetch('/api/auth/explicit-signout', { method: 'POST' });
    window.location.href = '/login';
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
