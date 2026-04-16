'use client';

import { Suspense, useState, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
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

function SetupPasswordForm() {
  const searchParams = useSearchParams();
  const token = searchParams.get('token') || '';
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [tokenError, setTokenError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isValidating, setIsValidating] = useState(true);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);

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

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');

    if (password !== confirmPassword) {
      setError('パスワードが一致しません');
      return;
    }

    setIsLoading(true);

    try {
      const res = await fetch('/api/auth/setup-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password, confirmPassword }),
      });

      const json = await res.json();

      if (!res.ok) {
        setError(
          json.error?.details?.[0]?.message ||
            json.error?.message ||
            'パスワードの設定に失敗しました',
        );
        return;
      }

      setRecoveryCodes(json.data.recoveryCodes);
    } catch {
      setError('エラーが発生しました。しばらくしてから再度お試しください。');
    } finally {
      setIsLoading(false);
    }
  }

  if (isValidating) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
        <Card className="w-full max-w-md">
          <CardContent className="py-8 text-center text-gray-500">
            確認中...
          </CardContent>
        </Card>
      </div>
    );
  }

  if (tokenError) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <CardTitle className="text-2xl">たすきば</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-md bg-red-50 p-3 text-sm text-red-600">{tokenError}</div>
            <p className="text-center text-sm text-gray-500">
              管理者に新しい招待メールの再送を依頼してください。
            </p>
            <Button className="w-full" onClick={() => { window.location.href = '/login'; }}>
              ログイン画面へ
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (recoveryCodes) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <CardTitle className="text-2xl">パスワード設定完了</CardTitle>
            <CardDescription>
              アカウントが有効化されました。以下のリカバリーコードを安全な場所に保管してください。
              <strong className="block mt-1 text-red-600">このコードは再表示できません。</strong>
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-md bg-gray-50 p-4 font-mono text-sm">
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
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">たすきば</CardTitle>
          <CardDescription>パスワードを設定してアカウントを有効化します</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            {error && (
              <div className="rounded-md bg-red-50 p-3 text-sm text-red-600">{error}</div>
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
              <p className="text-xs text-gray-500">
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
            <Button type="submit" className="w-full" disabled={isLoading}>
              {isLoading ? '設定中...' : 'パスワードを設定'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
