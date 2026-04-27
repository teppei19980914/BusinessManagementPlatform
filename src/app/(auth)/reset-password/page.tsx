'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export default function ResetPasswordPage() {
  const t = useTranslations('auth');
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
      setError(json.error?.message || t('authFailed'));
      return;
    }

    setResetToken(json.data.token);
    setStep('reset');
  }

  async function handleReset(e: React.FormEvent) {
    e.preventDefault();
    setError('');

    if (resetForm.newPassword !== resetForm.confirmPassword) {
      setError(t('passwordMismatch'));
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
      setError(json.error?.message || t('passwordChangeFailed'));
      return;
    }

    setSuccess(t('passwordChangedRedirect'));
    setTimeout(() => router.push('/login'), 3000);
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted px-4">
      <Card className="w-full max-w-[min(90vw,28rem)]">
        <CardHeader className="text-center">
          <CardTitle>{t('resetPasswordTitle')}</CardTitle>
          <CardDescription>
            {step === 'verify' ? t('resetPasswordStep1Hint') : t('resetPasswordStep2Hint')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {success ? (
            <div className="rounded-md bg-success/10 p-4 text-sm text-success">{success}</div>
          ) : step === 'verify' ? (
            <form onSubmit={handleVerify} className="space-y-4">
              {error && <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}
              <div className="space-y-2">
                <Label>{t('email')}</Label>
                <Input
                  type="email"
                  value={verifyForm.email}
                  onChange={(e) => setVerifyForm({ ...verifyForm, email: e.target.value })}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label>{t('recoveryCode')}</Label>
                <Input
                  value={verifyForm.recoveryCode}
                  onChange={(e) => setVerifyForm({ ...verifyForm, recoveryCode: e.target.value })}
                  placeholder="XXXX-XXXX"
                  required
                />
              </div>
              <Button type="submit" className="w-full" disabled={isLoading}>
                {isLoading ? t('verifying') : t('verifyIdentity')}
              </Button>
              <p className="text-center text-xs text-muted-foreground">
                <a href="/login" className="text-info hover:underline">{t('backToLogin')}</a>
              </p>
            </form>
          ) : (
            <form onSubmit={handleReset} className="space-y-4">
              {error && <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}
              <div className="space-y-2">
                <Label>{t('newPassword')}</Label>
                <Input
                  type="password"
                  value={resetForm.newPassword}
                  onChange={(e) => setResetForm({ ...resetForm, newPassword: e.target.value })}
                  required
                />
                <p className="text-xs text-muted-foreground">{t('passwordHint')}</p>
              </div>
              <div className="space-y-2">
                <Label>{t('newPasswordConfirm')}</Label>
                <Input
                  type="password"
                  value={resetForm.confirmPassword}
                  onChange={(e) => setResetForm({ ...resetForm, confirmPassword: e.target.value })}
                  required
                />
              </div>
              <Button type="submit" className="w-full" disabled={isLoading}>
                {isLoading ? t('changing') : t('changePassword')}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
