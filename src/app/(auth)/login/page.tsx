'use client';

import { Suspense, useState } from 'react';
import { signIn } from 'next-auth/react';
import { useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
// PR #117: JST 固定タイムゾーン描画 (ハイドレーション安全)
import { formatDateTimeFull } from '@/lib/format';

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const searchParams = useSearchParams();
  const callbackUrl = searchParams.get('callbackUrl') || '/';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setIsLoading(true);

    const result = await signIn('credentials', {
      email,
      password,
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
        body: JSON.stringify({ email }),
      }).catch(() => null);
      const lock = lockRes && lockRes.ok
        ? (await lockRes.json().catch(() => null) as
            | { status: 'permanent_lock' }
            | { status: 'temporary_lock'; unlockAt: string }
            | { status: 'none' }
            | null)
        : null;

      if (lock?.status === 'permanent_lock') {
        setError('アカウントがロックされています。管理者に解除を依頼してください。');
      } else if (lock?.status === 'temporary_lock') {
        // PR #117: JST 固定フォーマットで表示 (環境依存せず常に同じ表記)
        setError(
          `ログイン失敗が続いたためアカウントが一時ロックされています。${formatDateTimeFull(lock.unlockAt)} 以降に再度お試しください。`,
        );
      } else {
        setError('メールアドレスまたはパスワードが正しくありません');
      }
      setIsLoading(false);
      return;
    }

    setIsLoading(false);
    // フルページリロードで Cookie を確実に送信（Vercel 環境対応）
    window.location.href = callbackUrl;
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted px-4">
      <Card className="w-full max-w-[min(90vw,28rem)]">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">たすきば</CardTitle>
          <CardDescription>Knowledge Relay</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            {error && (
              <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>
            )}
            <div className="space-y-2">
              <Label htmlFor="email">メールアドレス</Label>
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
              <Label htmlFor="password">パスワード</Label>
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
              {isLoading ? 'ログイン中...' : 'ログイン'}
            </Button>
            <p className="text-center text-xs text-muted-foreground">
              <a href="/reset-password" className="text-info hover:underline">
                パスワードをお忘れですか？
              </a>
            </p>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
