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

import { useMemo, useState } from 'react';
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
import { nativeSelectClass } from '@/components/ui/native-select-style';
import { THEMES, toSafeThemeId, type ThemeId } from '@/types';
import { THEME_DEFINITIONS, SUPPORTED_LOCALES, SELECTABLE_LOCALES, DEFAULT_TIMEZONE, DEFAULT_LOCALE } from '@/config';

type Props = {
  mfaEnabled: boolean;
  isAdmin: boolean;
  /** PR #72: 現在の画面テーマ (初期選択値) */
  currentTheme: string;
  /** PR #119: 現在のタイムゾーン (null = システム既定継承) */
  currentTimezone: string | null;
  /** PR #119: 現在のロケール (null = システム既定継承) */
  currentLocale: string | null;
};

export function SettingsClient({
  mfaEnabled,
  isAdmin,
  currentTheme,
  currentTimezone,
  currentLocale,
}: Props) {
  const router = useRouter();
  const { withLoading } = useLoading();
  const { showSuccess, showError } = useToast();
  const { update: updateSession } = useSession();
  const tSetting = useTranslations('setting');
  const tField = useTranslations('field');
  const tAuth = useTranslations('auth');
  const tAction = useTranslations('action');
  const tMessage = useTranslations('message');

  // PR #72: テーマ設定
  const [theme, setTheme] = useState<ThemeId>(toSafeThemeId(currentTheme));
  const [themeError, setThemeError] = useState('');
  const [themeSuccess, setThemeSuccess] = useState('');

  // PR #119: i18n 設定 (タイムゾーン / ロケール)。'' は「システム既定を継承」の UI 表現 (DB 側は null)。
  const [tzValue, setTzValue] = useState<string>(currentTimezone ?? '');
  const [localeValue, setLocaleValue] = useState<string>(currentLocale ?? '');
  const [i18nError, setI18nError] = useState('');
  const [i18nSuccess, setI18nSuccess] = useState('');

  // Intl.supportedValuesOf('timeZone') で IANA タイムゾーン名一覧を動的取得 (2022 以降標準)。
  // ブラウザ非対応時の fallback は限定的な代表値のみ表示する。
  const tzOptions = useMemo<string[]>(() => {
    try {
      const supported = Intl.supportedValuesOf as ((key: 'timeZone') => string[]) | undefined;
      if (typeof supported === 'function') return supported('timeZone');
    } catch {
      // 非対応ブラウザは fallback へ
    }
    return ['UTC', 'Asia/Tokyo', 'Asia/Shanghai', 'Asia/Seoul', 'America/New_York', 'America/Los_Angeles', 'Europe/London', 'Europe/Paris'];
  }, []);

  async function handleI18nSave(e: React.FormEvent) {
    e.preventDefault();
    setI18nError('');
    setI18nSuccess('');

    // '' は null (= システム既定に戻す) として送信
    const body = {
      timezone: tzValue === '' ? null : tzValue,
      locale: localeValue === '' ? null : localeValue,
    };

    const res = await withLoading(() =>
      fetch('/api/settings/i18n', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      const msg = json.error?.message || tSetting('i18nSaveFailed');
      setI18nError(msg);
      showError('言語・タイムゾーン設定の保存に失敗しました');
      return;
    }
    // JWT 反映 (次のレンダリング以降、全 useFormatters が新値を使う)
    await updateSession({ timezone: body.timezone, locale: body.locale });
    setI18nSuccess(tSetting('i18nSaved'));
    showSuccess('言語・タイムゾーン設定を保存しました');
    // 既存描画 (特にサーバコンポーネント) を再計算して即時反映
    router.refresh();
  }

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

      {/* PR #119: 言語・タイムゾーン設定 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">{tSetting('i18nTitle')}</CardTitle>
          <CardDescription>
            {tSetting('i18nDescription')}
            <span className="ml-1 font-mono text-xs">{DEFAULT_TIMEZONE}</span>
            {' / '}
            <span className="font-mono text-xs">{DEFAULT_LOCALE}</span>
          </CardDescription>
        </CardHeader>
        <CardContent>
          {i18nError && (
            <div className="mb-3 rounded-md bg-destructive/10 p-3 text-sm text-destructive">{i18nError}</div>
          )}
          {i18nSuccess && (
            <div className="mb-3 rounded-md bg-success/10 p-3 text-sm text-success">{i18nSuccess}</div>
          )}
          <form onSubmit={handleI18nSave} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="i18n-locale">{tSetting('language')}</Label>
              <select
                id="i18n-locale"
                value={localeValue}
                onChange={(e) => setLocaleValue(e.target.value)}
                className={nativeSelectClass}
              >
                <option value="">{tSetting('useSystemDefault', { value: DEFAULT_LOCALE })}</option>
                {Object.entries(SUPPORTED_LOCALES).map(([key, label]) => {
                  // PR #120: SELECTABLE_LOCALES=false のロケールは表示するが選択不可。
                  //   「将来対応予定」を利用者に示しつつ、翻訳未完の値で UI を壊さないための措置。
                  //   多層防御として API (validators/i18n.ts) でも 400 拒否される。
                  const selectable = SELECTABLE_LOCALES[key as keyof typeof SELECTABLE_LOCALES];
                  return (
                    <option key={key} value={key} disabled={!selectable}>
                      {tSetting('localeOption', { label, key })}{!selectable && tSetting('localePreparing')}
                    </option>
                  );
                })}
              </select>
              <p className="text-xs text-muted-foreground">
                {tSetting('localePreparingHint')}
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="i18n-tz">{tSetting('timezone')}</Label>
              <select
                id="i18n-tz"
                value={tzValue}
                onChange={(e) => setTzValue(e.target.value)}
                className={nativeSelectClass}
              >
                <option value="">{tSetting('useSystemDefault', { value: DEFAULT_TIMEZONE })}</option>
                {tzOptions.map((tz) => (
                  <option key={tz} value={tz}>{tz}</option>
                ))}
              </select>
            </div>
            <Button type="submit">{tAction('save')}</Button>
          </form>
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
