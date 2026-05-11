'use client';

/**
 * 設定画面 (アカウントメニュー → 設定) のクライアントコンポーネント。
 *
 * 役割:
 *   ログイン中ユーザの個人設定を管理する:
 *   1. 画面テーマ (PR #72): 10 種から選択、DB に永続化されセッションを跨いで適用
 *   2. パスワード変更 (現パスワード認証 + 新パスワードのポリシー検証 + 履歴チェック)
 *   3. MFA 有効化 / 無効化 (PR #67、admin は無効化不可)
 *
 * テーマ変更フロー:
 *   - PATCH /api/settings/theme → DB 更新
 *   - useSession().update() で JWT を更新 → layout.tsx の <html data-theme> 即時反映
 *   - router.refresh() で SSR を再実行 (フラッシュ防止)
 *
 * 認可: getAuthenticatedUser のみ。ロール条件なし (本人のみ操作可)。
 *
 * 関連:
 *   - SPECIFICATION.md §22 / §23 (設定画面)
 *   - DESIGN.md §28 / §29 (テーマシステム)
 *   - DESIGN.md §9.5 (MFA 設計)
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { useTranslations } from 'next-intl';
import { useLoading } from '@/components/loading-overlay';
import { useToast } from '@/components/toast-provider';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { THEMES, toSafeThemeId, type ThemeId } from '@/types';
import { THEME_DEFINITIONS } from '@/config';

type Props = {
  mfaEnabled: boolean;
  // 2026-05-09 (#11): 旧 `systemRole === 'admin'` 判定から super_admin 限定へ。
  //   名前は後方互換のため維持。意味は「MFA 強制ユーザか (= super_admin)」。
  isAdmin: boolean;
  /** PR #72: 現在の画面テーマ (初期選択値) */
  currentTheme: string;
};

export function SettingsClient({
  mfaEnabled,
  isAdmin,
  currentTheme,
}: Props) {
  const router = useRouter();
  const { withLoading } = useLoading();
  const { showSuccess, showError } = useToast();
  const { update: updateSession } = useSession();
  const tSetting = useTranslations('setting');
  const tField = useTranslations('field');
  const tAuth = useTranslations('auth');
  const tMessage = useTranslations('message');

  // PR #72: テーマ設定
  const [theme, setTheme] = useState<ThemeId>(toSafeThemeId(currentTheme));
  const [themeError, setThemeError] = useState('');
  const [themeSuccess, setThemeSuccess] = useState('');

  // PR-1 (2026-05-15): timezone / locale はテナント設定画面 (/settings/tenant) に移動。
  //   テナント全体の TZ/locale で運用する方針 (同一テナント内のユーザ間で日付計算が
  //   揺らがないようにするため)。

  async function handleThemeChange(next: ThemeId) {
    setThemeError('');
    setThemeSuccess('');
    const prev = theme;
    setTheme(next);
    const res = await withLoading(() =>
      fetch('/api/settings/theme', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ theme: next }),
      }),
    );
    if (!res.ok) {
      setTheme(prev);
      const json = await res.json().catch(() => ({}));
      const msg = json.error?.message || tSetting('themeSaveFailed');
      setThemeError(msg);
      showError('テーマ設定の保存に失敗しました');
      return;
    }
    // セッション JWT に反映 → layout.tsx 側の <html data-theme> を next refresh で更新
    // (React の immutability ルール上、クライアントから直接 document を書き換えない)
    await updateSession({ themePreference: next });
    setThemeSuccess(tSetting('themeChanged'));
    showSuccess('テーマ設定を保存しました');
    router.refresh();
  }

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
      setPwError(tAuth('passwordMismatch'));
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
      const msg = json.error?.message || tMessage('passwordChangeFailed');
      setPwError(msg);
      showError('パスワードの変更に失敗しました');
      return;
    }

    setPwSuccess(tMessage('passwordChanged'));
    showSuccess('パスワードを変更しました');
    setPwForm({ currentPassword: '', newPassword: '', confirmPassword: '' });
  }

  async function handleMfaSetup() {
    setMfaError('');
    const res = await withLoading(() =>
      fetch('/api/auth/mfa/setup', { method: 'POST' }),
    );
    const json = await res.json();
    if (!res.ok) {
      setMfaError(json.error?.message || tSetting('mfaSetupFailed'));
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
      const msg = json.error?.message || tSetting('mfaCodeVerifyFailed');
      setMfaError(msg);
      showError('MFA の有効化に失敗しました');
      return;
    }

    setMfaStep('idle');
    setTotpCode('');
    showSuccess('MFA を有効化しました');
    router.refresh();
  }

  async function handleMfaDisable() {
    const res = await withLoading(() =>
      fetch('/api/auth/mfa/disable', { method: 'POST' }),
    );
    if (res.ok) {
      showSuccess('MFA を無効化しました');
      router.refresh();
    } else {
      showError('MFA の無効化に失敗しました');
    }
  }

  return (
    <div className="mx-auto max-w-[min(90vw,42rem)] space-y-6">
      <h2 className="text-xl font-semibold">{tSetting('title')}</h2>

      {/* PR #72: テーマ設定 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">{tSetting('themeTitle')}</CardTitle>
          <CardDescription>
            {tSetting('themeDescription')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {themeError && (
            <div className="mb-3 rounded-md bg-destructive/10 p-3 text-sm text-destructive">{themeError}</div>
          )}
          {themeSuccess && (
            <div className="mb-3 rounded-md bg-success/10 p-3 text-sm text-success">{themeSuccess}</div>
          )}
          <div role="radiogroup" aria-label={tSetting('themeTitle')} className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {(Object.entries(THEMES) as [ThemeId, string][]).map(([id, label]) => {
              const selected = id === theme;
              return (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => handleThemeChange(id)}
                  className={[
                    'flex items-center gap-3 rounded-md border p-3 text-left text-sm transition-colors',
                    selected ? 'border-info bg-info/10 ring-1 ring-info' : 'border-input hover:bg-muted',
                  ].join(' ')}
                >
                  <ThemeSwatch themeId={id} />
                  <span>{label}</span>
                  {selected && <span className="ml-auto text-xs text-info">{tSetting('themeSelected')}</span>}
                </button>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* パスワード変更 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">{tSetting('passwordChangeTitle')}</CardTitle>
          <CardDescription>{tSetting('passwordChangeDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handlePasswordChange} className="space-y-4">
            {pwError && <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{pwError}</div>}
            {pwSuccess && <div className="rounded-md bg-success/10 p-3 text-sm text-success">{pwSuccess}</div>}
            <div className="space-y-2">
              <Label htmlFor="current-password">{tField('currentPassword')}</Label>
              <Input id="current-password" type="password" value={pwForm.currentPassword} onChange={(e) => setPwForm({ ...pwForm, currentPassword: e.target.value })} required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="new-password">{tField('newPassword')}</Label>
              <Input id="new-password" type="password" value={pwForm.newPassword} onChange={(e) => setPwForm({ ...pwForm, newPassword: e.target.value })} required />
              <p className="text-xs text-muted-foreground">{tAuth('passwordHint')}</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="confirm-password">{tField('newPasswordConfirm')}</Label>
              <Input id="confirm-password" type="password" value={pwForm.confirmPassword} onChange={(e) => setPwForm({ ...pwForm, confirmPassword: e.target.value })} required />
            </div>
            <Button type="submit">{tSetting('submitChange')}</Button>
          </form>
        </CardContent>
      </Card>

      {/* MFA */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">
            {tSetting('mfaTitle')}
            {mfaEnabled && isAdmin ? (
              // PR #91: admin は MFA 強制有効化。解除不可を明示する専用バッジ
              <Badge className="ml-2">{tSetting('mfaForcedBadge')}</Badge>
            ) : mfaEnabled ? (
              <Badge className="ml-2">{tSetting('mfaEnabledBadge')}</Badge>
            ) : (
              <Badge variant="outline" className="ml-2">{tSetting('mfaDisabledBadge')}</Badge>
            )}
          </CardTitle>
          <CardDescription>
            {tSetting('mfaDescription')}
            {isAdmin && tSetting('mfaAdminNote')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {mfaError && <div className="mb-4 rounded-md bg-destructive/10 p-3 text-sm text-destructive">{mfaError}</div>}

          {mfaStep === 'idle' && !mfaEnabled && (
            <Button onClick={handleMfaSetup}>{tSetting('mfaEnableButton')}</Button>
          )}

          {mfaStep === 'idle' && mfaEnabled && !isAdmin && (
            <Button variant="destructive" onClick={handleMfaDisable}>{tSetting('mfaDisableButton')}</Button>
          )}

          {mfaStep === 'idle' && mfaEnabled && isAdmin && (
            // PR #91: admin の MFA 解除ボタンは表示せず、代わりに常時案内文を表示
            <p className="text-sm text-muted-foreground">
              {tSetting('mfaAdminLockedNote')}
            </p>
          )}

          {mfaStep === 'verify' && (
            <div className="space-y-4">
              <div className="flex justify-center">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={qrCode} alt="QR Code" className="h-48 w-48" />
              </div>
              <p className="text-center text-sm text-muted-foreground">
                {tSetting('mfaScanHint')}
              </p>
              <details className="text-xs text-muted-foreground">
                <summary>{tSetting('mfaManualSecret')}</summary>
                <code className="mt-1 block rounded bg-accent p-2 font-mono">{mfaSecret}</code>
              </details>
              <form onSubmit={handleMfaEnable} className="flex gap-2">
                <Input
                  value={totpCode}
                  onChange={(e) => setTotpCode(e.target.value)}
                  placeholder={tSetting('mfaCodePlaceholder')}
                  maxLength={6}
                  className="w-32"
                  required
                />
                <Button type="submit">{tSetting('mfaVerifyAndEnable')}</Button>
              </form>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * PR #72: テーマのカラーサンプル (PR #76 で重複ハードコード除去)。
 *   各テーマ ID に応じた背景/基調色の組み合わせをプレビュー表示する。
 *   設定画面では他テーマも並列参照できるよう [data-theme="..."] コンテナ化しないため、
 *   `style` 属性で `THEME_DEFINITIONS` の値を直接展開する (テーマ定義の唯一の真実から派生)。
 */
function ThemeSwatch({ themeId }: { themeId: ThemeId }) {
  const tokens = THEME_DEFINITIONS[themeId];
  return (
    <span
      aria-hidden
      className="inline-flex h-8 w-12 shrink-0 overflow-hidden rounded border"
      style={{ background: tokens.background }}
    >
      <span className="h-full w-1/2" style={{ background: tokens.primary }} />
    </span>
  );
}
