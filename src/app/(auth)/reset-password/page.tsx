'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export default function ResetPasswordPage() {
  const router = useRouter();
  const [step, setStep] = useState<'verify' | 'reset'>('verify');
  const [resetToken, setResetToken] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const [verifyForm, setVerifyForm] = useState({ email: '', recoveryCode: '' });
  const [resetForm, setResetForm] = useState({ newPassword: '', confirmPassword: '' });

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setIsLoading(true);

    const res = await fetch('/api/auth/reset-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(verifyForm),
    });

    const json = await res.json();
    setIsLoading(false);

    if (!res.ok) {
      setError(json.error?.message || '認証に失敗しました');
      return;
    }

    setResetToken(json.data.token);
    setStep('reset');
  }

  async function handleReset(e: React.FormEvent) {
    e.preventDefault();
    setError('');

    if (resetForm.newPassword !== resetForm.confirmPassword) {
      setError('パスワードが一致しません');
      return;
    }

    setIsLoading(true);

    const res = await fetch('/api/auth/reset-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: resetToken, newPassword: resetForm.newPassword }),
    });

    const json = await res.json();
    setIsLoading(false);

    if (!res.ok) {
      setError(json.error?.message || 'パスワードの変更に失敗しました');
      return;
    }

    setSuccess('パスワードが変更されました。新しいパスワードでログインしてください。');
    setTimeout(() => router.push('/login'), 3000);
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CardTitle>パスワードリセット</CardTitle>
          <CardDescription>
            {step === 'verify'
              ? 'メールアドレスとリカバリーコードを入力してください'
              : '新しいパスワードを入力してください'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {success ? (
            <div className="rounded-md bg-green-50 p-4 text-sm text-green-600">{success}</div>
          ) : step === 'verify' ? (
            <form onSubmit={handleVerify} className="space-y-4">
              {error && <div className="rounded-md bg-red-50 p-3 text-sm text-red-600">{error}</div>}
              <div className="space-y-2">
                <Label>メールアドレス</Label>
                <Input
                  type="email"
                  value={verifyForm.email}
                  onChange={(e) => setVerifyForm({ ...verifyForm, email: e.target.value })}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label>リカバリーコード</Label>
                <Input
                  value={verifyForm.recoveryCode}
                  onChange={(e) => setVerifyForm({ ...verifyForm, recoveryCode: e.target.value })}
                  placeholder="XXXX-XXXX"
                  required
                />
              </div>
              <Button type="submit" className="w-full" disabled={isLoading}>
                {isLoading ? '確認中...' : '本人確認'}
              </Button>
              <p className="text-center text-xs text-gray-500">
                <a href="/login" className="text-blue-600 hover:underline">ログインに戻る</a>
              </p>
            </form>
          ) : (
            <form onSubmit={handleReset} className="space-y-4">
              {error && <div className="rounded-md bg-red-50 p-3 text-sm text-red-600">{error}</div>}
              <div className="space-y-2">
                <Label>新しいパスワード</Label>
                <Input
                  type="password"
                  value={resetForm.newPassword}
                  onChange={(e) => setResetForm({ ...resetForm, newPassword: e.target.value })}
                  required
                />
                <p className="text-xs text-gray-500">10文字以上、英大文字・英小文字・数字・記号のうち3種以上</p>
              </div>
              <div className="space-y-2">
                <Label>新しいパスワード（確認）</Label>
                <Input
                  type="password"
                  value={resetForm.confirmPassword}
                  onChange={(e) => setResetForm({ ...resetForm, confirmPassword: e.target.value })}
                  required
                />
              </div>
              <Button type="submit" className="w-full" disabled={isLoading}>
                {isLoading ? '変更中...' : 'パスワード変更'}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
