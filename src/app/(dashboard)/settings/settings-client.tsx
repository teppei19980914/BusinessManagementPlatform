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
// feat/settings-tenant-identity (2026-05-21): JST 固定フォーマット (ハイドレーション安全)
// アカウント作成日時は監査列のため秒まで (formatDateTimeSeconds)。MFA 有効化日時は分まで (formatDateTimeFull)。
import { formatDateTimeFull, formatDateTimeSeconds } from '@/lib/format';

/**
 * feat/settings-tenant-identity (2026-05-21):
 *   ユーザ個別の「アカウント情報」セクション表示用 DTO。
 *   page.tsx (Server Component) で Date を ISO string にシリアライズ済み。
 */
export type AccountInfoProp = {
  id: string;
  name: string;
  email: string;
  systemRole: string;
  mfaEnabled: boolean;
  /** ISO 8601 文字列 (null = MFA 無効) */
  mfaEnabledAt: string | null;
  /** ISO 8601 文字列 (null = 初回ログイン中) */
  lastLoginAt: string | null;
  /** ISO 8601 文字列 (アカウント作成日時) */
  createdAt: string;
  tenant: {
    slug: string;
    name: string;
  };
};

type Props = {
  mfaEnabled: boolean;
  // 2026-05-09 (#11): 旧 `systemRole === 'admin'` 判定から super_admin 限定へ。
  //   名前は後方互換のため維持。意味は「MFA 強制ユーザか (= super_admin)」。
  isAdmin: boolean;
  /** PR #72: 現在の画面テーマ (初期選択値) */
  currentTheme: string;
  /**
   * fix/admin-users-defensive-render 横展開 (2026-05-15): server 側 data 取得が失敗した時に
   * 表示する警告バナーの可否。デフォルト false (= 正常)。
   *
   * 注: timezone / locale は PR-1 (#327) でユーザ単位 → テナント単位に集約されたため
   * 本 Client から prop 受領しなくなった。テナント側設定は /settings/tenant で行う。
   */
  dataLoadError?: boolean;
  /**
   * feat/settings-tenant-identity (2026-05-21): 自分のアカウント情報。
   * null = data load 失敗 (バナー表示) または getUserSelfAccountInfo が null を返した状態 →
   * アカウント情報セクションを描画しない。
   */
  accountInfo?: AccountInfoProp | null;
};

export function SettingsClient({
  mfaEnabled,
  isAdmin,
  currentTheme,
  dataLoadError = false,
  accountInfo = null,
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
      showError(tSetting('toastThemeSaveFailed'));
      return;
    }
    // セッション JWT に反映 → layout.tsx 側の <html data-theme> を next refresh で更新
    // (React の immutability ルール上、クライアントから直接 document を書き換えない)
    await updateSession({ themePreference: next });
    setThemeSuccess(tSetting('themeChanged'));
    showSuccess(tSetting('toastThemeSaveSuccess'));
    router.refresh();
  }

  // パスワード変更
  const [pwForm, setPwForm] = useState({ currentPassword: '', newPassword: '', confirmPassword: '' });
  const [pwError, setPwError] = useState('');
  const [pwSuccess, setPwSuccess] = useState('');

  // feat/logout-other-devices (2026-06-03): 現在の端末以外の全セッションを無効化する。
  //   API が tokenVersion を increment し、呼出端末のみ JWT を再署名 (現端末はログイン維持)。
  const [logoutOthersError, setLogoutOthersError] = useState('');
  const [logoutOthersSuccess, setLogoutOthersSuccess] = useState('');

  async function handleLogoutOtherDevices() {
    if (!window.confirm(tSetting('logoutOtherDevicesConfirm'))) return;
    setLogoutOthersError('');
    setLogoutOthersSuccess('');
    const res = await withLoading(() =>
      fetch('/api/auth/logout-other-devices', { method: 'POST' }),
    );
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      setLogoutOthersError(json.error?.message || tSetting('logoutOtherDevicesFailed'));
      showError(tSetting('toastSignOutOthersFailed'));
      return;
    }
    setLogoutOthersSuccess(tSetting('logoutOtherDevicesSuccess'));
    showSuccess(tSetting('toastSignOutOthersSuccess'));
  }

  // MFA
  // 2026-05-18 (fix/cron-public-paths-and-stripe-disabled-guard, bundle 修正):
  //   無効化フローは 2026-05-13 B-5 hardening により再認証 (現パスワード + 現 TOTP) 必須。
  //   旧 UI は空 body を POST して 400 になっていたため、'disable-confirm' ステップを追加。
  //   詳細: docs/knowledge/KDD_PATTERNS.md §5.X+70 / src/app/api/auth/mfa/disable/route.ts
  const [mfaStep, setMfaStep] = useState<'idle' | 'setup' | 'verify' | 'disable-confirm'>('idle');
  const [qrCode, setQrCode] = useState('');
  const [mfaSecret, setMfaSecret] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [mfaError, setMfaError] = useState('');
  // 無効化フロー用の入力 (B-5 再認証)
  const [disableCurrentPassword, setDisableCurrentPassword] = useState('');
  const [disableTotpCode, setDisableTotpCode] = useState('');

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
      showError(tSetting('toastPasswordChangeFailed'));
      return;
    }

    setPwSuccess(tMessage('passwordChanged'));
    showSuccess(tSetting('toastPasswordChangeSuccess'));
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
      showError(tSetting('toastMfaEnableFailed'));
      return;
    }

    setMfaStep('idle');
    setTotpCode('');
    showSuccess(tSetting('toastMfaEnableSuccess'));
    router.refresh();
  }

  // 2026-05-18: 「MFA を無効化する」ボタン → 再認証フォームへ遷移するだけのハンドラ。
  // 実際の disable 呼出は handleMfaDisableSubmit で行う。
  function handleMfaDisableStart() {
    setMfaError('');
    setDisableCurrentPassword('');
    setDisableTotpCode('');
    setMfaStep('disable-confirm');
  }

  function handleMfaDisableCancel() {
    setMfaError('');
    setDisableCurrentPassword('');
    setDisableTotpCode('');
    setMfaStep('idle');
  }

  async function handleMfaDisableSubmit(e: React.FormEvent) {
    e.preventDefault();
    setMfaError('');

    // mfaEnabled=true なら server 側で TOTP 必須 (= MFA_DISABLE_TOTP_REQUIRED の事前抑止)
    if (mfaEnabled && disableTotpCode.length !== 6) {
      setMfaError(tSetting('mfaDisableTotpRequired'));
      return;
    }

    const body: { currentPassword: string; totpCode?: string } = {
      currentPassword: disableCurrentPassword,
    };
    if (disableTotpCode.length === 6) body.totpCode = disableTotpCode;

    const res = await withLoading(() =>
      fetch('/api/auth/mfa/disable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );

    if (res.ok) {
      setMfaStep('idle');
      setDisableCurrentPassword('');
      setDisableTotpCode('');
      showSuccess(tSetting('toastMfaDisableSuccess'));
      router.refresh();
      return;
    }

    // server から返る code に応じて i18n メッセージへマップ。message は fallback。
    const json = await res.json().catch(() => ({}));
    const code = json?.error?.code as string | undefined;
    const fallbackMsg = json?.error?.message ?? tSetting('mfaDisableFailed');
    if (code === 'INVALID_CREDENTIALS') {
      setMfaError(tSetting('mfaDisableInvalidPassword'));
    } else if (code === 'INVALID_TOTP') {
      setMfaError(tSetting('mfaDisableInvalidTotp'));
    } else if (code === 'TOTP_REQUIRED') {
      setMfaError(tSetting('mfaDisableTotpRequired'));
    } else if (code === 'MFA_LOCKED') {
      setMfaError(tSetting('mfaDisableLocked'));
    } else {
      setMfaError(fallbackMsg);
    }
    showError(tSetting('toastMfaDisableFailed'));
  }

  return (
    <div className="mx-auto max-w-[min(90vw,42rem)] space-y-6">
      {/* fix/admin-users-defensive-render 横展開 (2026-05-15): server data load 失敗時のバナー。
          prisma.user.findUnique が throw した場合、フォールバック値で UI 描画継続。 */}
      {dataLoadError && (
        <div className="rounded border border-destructive/30 bg-destructive/10 p-3 text-sm">
          <p className="font-semibold">{tSetting('loadFailedTitle')}</p>
          <p className="mt-1 text-muted-foreground">
            {tSetting('loadFailedMessageRetry')}{' '}{tSetting('loadFailedMessageContact')}
          </p>
        </div>
      )}
      {/*
        feat/footer-auth-aware-links (2026-05-31):
          旧「サービス情報 → (/settings/about)」リンクは撤去。サービスの素性 (運営者 /
          規約 / 特商法) は外部 LP に集約し、フッタ共通情報から到達する方針へ統一したため。
          /settings/about ページ自体も本 PR で削除済。
      */}
      {/* 画面名「設定」見出しは撤去 — CollapsedNavScreenTitle (layout) が全画面幅で表示する。 */}

      {/* feat/settings-tenant-identity (2026-05-21): アカウント情報セクション。
          一般ユーザが「次回ログイン時の組織 ID」「自分のメール / 氏名 / ロール」を
          管理者に問い合わせずに確認できるようにする。テナント識別子は slug + name のみ
          (UUID / tenantSeq は管理者向けで /settings/tenant に留める)。
          ADR-0017 (2026-05-21) 参照。 */}
      {accountInfo && (
        <Card data-testid="account-info-section">
          <CardHeader>
            <CardTitle className="text-lg">{tSetting('accountInfoTitle')}</CardTitle>
            <CardDescription>{tSetting('accountInfoDescription')}</CardDescription>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-[max-content_1fr]">
              <dt className="text-muted-foreground">{tSetting('accountInfoTenantSlug')}</dt>
              <dd className="font-mono" data-testid="account-info-tenant-slug">
                {accountInfo.tenant.slug}
              </dd>
              <dt className="text-muted-foreground">{tSetting('accountInfoTenantName')}</dt>
              <dd data-testid="account-info-tenant-name">{accountInfo.tenant.name}</dd>
              <dt className="text-muted-foreground">{tSetting('accountInfoEmail')}</dt>
              <dd data-testid="account-info-email">{accountInfo.email}</dd>
              <dt className="text-muted-foreground">{tSetting('accountInfoName')}</dt>
              <dd data-testid="account-info-name">{accountInfo.name}</dd>
              <dt className="text-muted-foreground">{tSetting('accountInfoSystemRole')}</dt>
              <dd data-testid="account-info-system-role">
                <Badge variant="outline">
                  {/* `systemRole` は schema 上 VarChar(20) で enum 制限が無いため、
                      予期しない値 (運用ミスでの insert 等) は最終フォールバックとして
                      「一般ユーザ」表示にする。安全側の fail-safe を優先。 */}
                  {accountInfo.systemRole === 'super_admin'
                    ? tSetting('systemRoleSuperAdmin')
                    : accountInfo.systemRole === 'admin'
                      ? tSetting('systemRoleAdmin')
                      : tSetting('systemRoleGeneral')}
                </Badge>
              </dd>
              <dt className="text-muted-foreground">{tSetting('accountInfoLastLogin')}</dt>
              <dd data-testid="account-info-last-login">
                {accountInfo.lastLoginAt
                  ? formatDateTimeFull(accountInfo.lastLoginAt)
                  : tSetting('accountInfoLastLoginNever')}
              </dd>
              <dt className="text-muted-foreground">{tSetting('accountInfoMfaEnabledAt')}</dt>
              <dd data-testid="account-info-mfa-enabled-at">
                {accountInfo.mfaEnabledAt
                  ? formatDateTimeFull(accountInfo.mfaEnabledAt)
                  : tSetting('accountInfoMfaEnabledAtNever')}
              </dd>
              <dt className="text-muted-foreground">{tSetting('accountInfoCreatedAt')}</dt>
              <dd data-testid="account-info-created-at">
                {formatDateTimeSeconds(accountInfo.createdAt)}
              </dd>
            </dl>
            <p className="mt-3 text-xs text-muted-foreground">
              {tSetting('accountInfoHint')}
            </p>
          </CardContent>
        </Card>
      )}

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
            <Button variant="destructive" onClick={handleMfaDisableStart}>{tSetting('mfaDisableButton')}</Button>
          )}

          {mfaStep === 'disable-confirm' && (
            // 2026-05-18: B-5 hardening により MFA 無効化は現パスワード + 現 TOTP 必須。
            //   server schema: src/app/api/auth/mfa/disable/route.ts disableMfaSchema。
            <form onSubmit={handleMfaDisableSubmit} className="space-y-4">
              <p className="text-sm text-muted-foreground">
                {tSetting('mfaDisableReauthHint')}
              </p>
              <div className="space-y-2">
                <Label htmlFor="mfa-disable-password">{tField('currentPassword')}</Label>
                <Input
                  id="mfa-disable-password"
                  type="password"
                  value={disableCurrentPassword}
                  onChange={(e) => setDisableCurrentPassword(e.target.value)}
                  autoComplete="current-password"
                  required
                />
              </div>
              {mfaEnabled && (
                <div className="space-y-2">
                  <Label htmlFor="mfa-disable-totp">{tSetting('mfaDisableTotpLabel')}</Label>
                  <Input
                    id="mfa-disable-totp"
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    value={disableTotpCode}
                    onChange={(e) => setDisableTotpCode(e.target.value.replace(/[^0-9]/g, ''))}
                    placeholder={tSetting('mfaCodePlaceholder')}
                    maxLength={6}
                    className="w-32"
                    required
                  />
                </div>
              )}
              <div className="flex gap-2">
                <Button type="submit" variant="destructive">{tSetting('mfaDisableSubmit')}</Button>
                <Button type="button" variant="outline" onClick={handleMfaDisableCancel}>
                  {tSetting('cancel')}
                </Button>
              </div>
            </form>
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

      {/* feat/logout-other-devices (2026-06-03): 他端末セッションの一括無効化 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">{tSetting('logoutOtherDevicesTitle')}</CardTitle>
          <CardDescription>{tSetting('logoutOtherDevicesDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          {logoutOthersError && (
            <div className="mb-3 rounded-md bg-destructive/10 p-3 text-sm text-destructive">{logoutOthersError}</div>
          )}
          {logoutOthersSuccess && (
            <div className="mb-3 rounded-md bg-success/10 p-3 text-sm text-success">{logoutOthersSuccess}</div>
          )}
          <Button variant="destructive" onClick={handleLogoutOtherDevices}>
            {tSetting('logoutOtherDevicesButton')}
          </Button>
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
