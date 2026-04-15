'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useLoading } from '@/components/loading-overlay';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

type Props = {
  mfaEnabled: boolean;
  isAdmin: boolean;
};

export function SettingsClient({ mfaEnabled, isAdmin }: Props) {
  const router = useRouter();
  const { withLoading } = useLoading();

  // パスワード変更
  const [pwForm, setPwForm] = useState({ currentPassword: '', newPassword: '', confirmPassword: '' });
  const [pwError, setPwError] = useState('');
  const [pwSuccess, setPwSuccess] = useState('');

  // MFA
  const [mfaStep, setMfaStep] = useState<'idle' | 'setup' | 'verify'>('idle');
  const [qrCode, setQrCode] = useState('');
  const [mfaSecret, setMfaSecret] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [mfaError, setMfaError] = useState('');

  async function handlePasswordChange(e: React.FormEvent) {
    e.preventDefault();
    setPwError('');
    setPwSuccess('');

    if (pwForm.newPassword !== pwForm.confirmPassword) {
      setPwError('パスワードが一致しません');
      return;
    }

    const res = await withLoading(() =>
      fetch('/api/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: pwForm.currentPassword, newPassword: pwForm.newPassword }),
      }),
    );

    const json = await res.json();
    if (!res.ok) {
      setPwError(json.error?.message || 'パスワードの変更に失敗しました');
      return;
    }

    setPwSuccess('パスワードが変更されました');
    setPwForm({ currentPassword: '', newPassword: '', confirmPassword: '' });
  }

  async function handleMfaSetup() {
    setMfaError('');
    const res = await withLoading(() =>
      fetch('/api/auth/mfa/setup', { method: 'POST' }),
    );
    const json = await res.json();
    if (!res.ok) {
      setMfaError(json.error?.message || 'MFA の設定に失敗しました');
      return;
    }
    setQrCode(json.data.qrCodeDataUrl);
    setMfaSecret(json.data.secret);
    setMfaStep('verify');
  }

  async function handleMfaEnable(e: React.FormEvent) {
    e.preventDefault();
    setMfaError('');

    const res = await withLoading(() =>
      fetch('/api/auth/mfa/enable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: totpCode }),
      }),
    );

    const json = await res.json();
    if (!res.ok) {
      setMfaError(json.error?.message || 'コードの検証に失敗しました');
      return;
    }

    setMfaStep('idle');
    setTotpCode('');
    router.refresh();
  }

  async function handleMfaDisable() {
    const res = await withLoading(() =>
      fetch('/api/auth/mfa/disable', { method: 'POST' }),
    );
    if (res.ok) router.refresh();
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <h2 className="text-xl font-semibold">設定</h2>

      {/* パスワード変更 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">パスワード変更</CardTitle>
          <CardDescription>現在のパスワードと新しいパスワードを入力してください。</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handlePasswordChange} className="space-y-4">
            {pwError && <div className="rounded-md bg-red-50 p-3 text-sm text-red-600">{pwError}</div>}
            {pwSuccess && <div className="rounded-md bg-green-50 p-3 text-sm text-green-600">{pwSuccess}</div>}
            <div className="space-y-2">
              <Label>現在のパスワード</Label>
              <Input type="password" value={pwForm.currentPassword} onChange={(e) => setPwForm({ ...pwForm, currentPassword: e.target.value })} required />
            </div>
            <div className="space-y-2">
              <Label>新しいパスワード</Label>
              <Input type="password" value={pwForm.newPassword} onChange={(e) => setPwForm({ ...pwForm, newPassword: e.target.value })} required />
              <p className="text-xs text-gray-500">10文字以上、英大文字・英小文字・数字・記号のうち3種以上</p>
            </div>
            <div className="space-y-2">
              <Label>新しいパスワード（確認）</Label>
              <Input type="password" value={pwForm.confirmPassword} onChange={(e) => setPwForm({ ...pwForm, confirmPassword: e.target.value })} required />
            </div>
            <Button type="submit">変更</Button>
          </form>
        </CardContent>
      </Card>

      {/* MFA */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">
            多要素認証（MFA）
            {mfaEnabled ? (
              <Badge className="ml-2">有効</Badge>
            ) : (
              <Badge variant="outline" className="ml-2">無効</Badge>
            )}
          </CardTitle>
          <CardDescription>
            認証アプリ（Google Authenticator 等）を使用した二段階認証を設定できます。
            {isAdmin && ' 管理者は MFA が必須です。'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {mfaError && <div className="mb-4 rounded-md bg-red-50 p-3 text-sm text-red-600">{mfaError}</div>}

          {mfaStep === 'idle' && !mfaEnabled && (
            <Button onClick={handleMfaSetup}>MFA を有効化する</Button>
          )}

          {mfaStep === 'idle' && mfaEnabled && !isAdmin && (
            <Button variant="destructive" onClick={handleMfaDisable}>MFA を無効化する</Button>
          )}

          {mfaStep === 'idle' && mfaEnabled && isAdmin && (
            <p className="text-sm text-gray-500">管理者は MFA を無効化できません。</p>
          )}

          {mfaStep === 'verify' && (
            <div className="space-y-4">
              <div className="flex justify-center">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={qrCode} alt="QR Code" className="h-48 w-48" />
              </div>
              <p className="text-center text-sm text-gray-500">
                認証アプリでこの QR コードをスキャンしてください。
              </p>
              <details className="text-xs text-gray-400">
                <summary>手動入力用のシークレットキー</summary>
                <code className="mt-1 block rounded bg-gray-100 p-2 font-mono">{mfaSecret}</code>
              </details>
              <form onSubmit={handleMfaEnable} className="flex gap-2">
                <Input
                  value={totpCode}
                  onChange={(e) => setTotpCode(e.target.value)}
                  placeholder="6桁のコード"
                  maxLength={6}
                  className="w-32"
                  required
                />
                <Button type="submit">検証して有効化</Button>
              </form>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
