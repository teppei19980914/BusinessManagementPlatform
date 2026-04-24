'use client';

/**
 * MFA 検証フォーム (PR #67 Client Component)。
 *
 * POST /api/auth/mfa/verify でコード検証 → 成功したら useSession().update()
 * で JWT を mfaVerified=true に更新し、callbackUrl へ遷移する。
 */

import { useState } from 'react';
import { useSession, signOut } from 'next-auth/react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export function MfaForm({ userId, callbackUrl }: { userId: string; callbackUrl: string }) {
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
        setError(json.error?.message || 'コードが正しくありません');
        return;
      }
      // JWT を mfaVerified=true で再発行 (auth.config.ts jwt callback の trigger='update' 経由)
      await update({ mfaVerified: true });
      // フルページリロードで最新 cookie を確実に送る (ログインと同じパターン)
      window.location.href = callbackUrl;
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
          <CardTitle className="text-2xl">2 段階認証</CardTitle>
          <CardDescription>
            認証アプリに表示された 6 桁のコードを入力してください
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            {error && (
              <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>
            )}
            {useRecovery ? (
              <div className="space-y-2">
                <Label htmlFor="recoveryCode">リカバリーコード</Label>
                {/* PR #128d: リカバリーコードは大文字英数字 (config/security.ts の RECOVERY_CODE_CHARSET)。
                    モバイル入力時の自動変換 (小文字化 / 自動校正 / 辞書変換) を無効化して誤入力を防ぐ。 */}
                <Input
                  id="recoveryCode"
                  value={recoveryCode}
                  onChange={(e) => setRecoveryCode(e.target.value)}
                  autoComplete="one-time-code"
                  autoCapitalize="characters"
                  autoCorrect="off"
                  spellCheck={false}
                  required
                />
              </div>
            ) : (
              <div className="space-y-2">
                <Label htmlFor="code">認証コード</Label>
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
              {isLoading ? '検証中...' : '検証'}
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
                {useRecovery ? '認証コードを使う' : 'リカバリーコードを使う'}
              </button>
              <button
                type="button"
                className="text-muted-foreground hover:underline"
                onClick={handleCancel}
              >
                ログアウト
              </button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
