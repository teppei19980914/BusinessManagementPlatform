'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useLoading } from '@/components/loading-overlay';
import { useToast } from '@/components/toast-provider';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { nativeSelectClass } from '@/components/ui/native-select-style';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { SYSTEM_ROLES } from '@/types';
import { NAME_MAX_LENGTH } from '@/config';
import type { UserDTO } from '@/services/user.service';
// PR #117 → PR #119: session 連携フォーマッタ (TZ/locale はユーザ設定を反映)
import { useFormatters } from '@/lib/use-formatters';

/**
 * ユーザ編集ダイアログ (PR #59 Req 3)。
 * API: PATCH /api/admin/users/:userId (システム管理者のみ)。
 *
 * feat/crud-permission-redesign (2026-05-20 追加要件):
 *   - 通常のテナント管理画面では「システム管理者 (super_admin)」を選択不可
 *     (super_admin は管理テナント所属で、テナント側からの昇格は禁止)
 *   - 自分自身のシステムロール変更は禁止 (他ユーザが必ず変更する設計)。
 *     UI 上は select を disabled にし、サーバー側でも 403 で弾く (api-helpers / route 層)
 */
export function UserEditDialog({
  user,
  open,
  onOpenChange,
  onSaved,
  currentUserId,
}: {
  user: UserDTO | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSaved: () => Promise<void> | void;
  /** ログイン中ユーザ自身の id。自己編集時にロール変更を禁止するため必須 */
  currentUserId: string;
}) {
  const tAction = useTranslations('action');
  const tField = useTranslations('field');
  const t = useTranslations('admin.userEdit');
  const { withLoading } = useLoading();
  const { showSuccess, showError } = useToast();
  // PR #119: session 連携フォーマッタ
  const { formatDateTimeFull } = useFormatters();
  const [form, setForm] = useState({
    name: '',
    systemRole: 'general' as 'admin' | 'general',
    isActive: true,
  });
  const [error, setError] = useState('');
  // 2026-06-03: リカバリーコード再発行で 1 回だけ返る平文コード。null = 未発行 (この画面で未操作)。
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  // PR #85: ロック判定用の「今」スナップショット (render 中に Date.now() を呼べないため)
  const [nowAtMount] = useState(() => Date.now());

  // PR #88: 編集ダイアログは開くたびに DB データを初期表示する。
  // prevUserId を null で初期化 + 閉じた時の null-reset を入れて、
  // 以下すべての経路で resync を保証:
  //   1) 別エンティティ A→B
  //   2) 同一エンティティを閉じて再度開く (A→null→A)
  //   3) 初回マウントで user が既にセットされているケース (初期値を null にしたため常に発火)
  const [prevUserId, setPrevUserId] = useState<string | null>(null);
  if (user && user.id !== prevUserId) {
    setPrevUserId(user.id);
    setForm({
      name: user.name,
      systemRole: user.systemRole as 'admin' | 'general',
      isActive: user.isActive,
    });
    setError('');
    // 別ユーザを開いたら前ユーザのコード平文を残さない (1 回表示の徹底)
    setRecoveryCodes(null);
  }
  if (!user && prevUserId !== null) {
    // ダイアログを閉じたら prevId を null に戻し、次回の同一 ID オープン時も resync させる
    setPrevUserId(null);
  }

  if (!user) return null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!user) return;
    setError('');
    const res = await withLoading(() =>
      fetch(`/api/admin/users/${user.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      }),
    );
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      const msg = json.error?.message || t('updateFailed');
      setError(msg);
      showError('ユーザの更新に失敗しました');
      return;
    }
    // feat/account-lock-and-ui-consistency: 作成と挙動統一、即時 close → reload は裏で
    onOpenChange(false);
    showSuccess('ユーザを更新しました');
    void onSaved();
  }

  // PR #85: ロック解除 (failedLoginCount / lockedUntil / permanentLock を一括クリア)
  async function handleUnlock() {
    if (!user) return;
    setError('');
    const res = await withLoading(() =>
      fetch(`/api/admin/users/${user.id}/unlock`, { method: 'POST' }),
    );
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      const msg = json.error?.message || t('unlockFailed');
      setError(msg);
      showError('ロック解除に失敗しました');
      return;
    }
    // feat/account-lock-and-ui-consistency: 作成と挙動統一、即時 close → reload は裏で
    onOpenChange(false);
    showSuccess('アカウントのロックを解除しました');
    void onSaved();
  }

  // 2026-06-03: リカバリーコード再発行 (MFA 復旧導線)。
  // 旧コードを全失効し新コード一式を生成。平文は応答で 1 回だけ返るため画面に表示して控えてもらう。
  // ダイアログは閉じない (コードを表示し続ける必要があるため)。
  async function handleReissueRecovery() {
    if (!user) return;
    if (!confirm(t('recoveryReissueConfirm', { name: user.name }))) return;
    setError('');
    const res = await withLoading(() =>
      fetch(`/api/admin/users/${user.id}/recovery-codes`, { method: 'POST' }),
    );
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      const msg = json.error?.message || t('recoveryReissueFailed');
      setError(msg);
      showError('リカバリーコードの再発行に失敗しました');
      return;
    }
    const json = await res.json().catch(() => ({ data: { recoveryCodes: [] } }));
    setRecoveryCodes(json?.data?.recoveryCodes ?? []);
    showSuccess(t('recoveryCodesDone'));
  }

  // 2026-06-03: 招待メールの再送 (招待中ユーザのみ)。即時 close → reload は裏で。
  async function handleResendInvitation() {
    if (!user) return;
    setError('');
    const res = await withLoading(() =>
      fetch(`/api/admin/users/${user.id}/resend-invitation`, { method: 'POST' }),
    );
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      const msg = json.error?.message || t('inviteResendFailed');
      setError(msg);
      showError('招待メールの再送に失敗しました');
      return;
    }
    onOpenChange(false);
    showSuccess('招待メールを再送しました');
    void onSaved();
  }

  // 2026-06-03: 招待の取消 (招待中ユーザのみ)。物理削除して席を解放する。
  async function handleCancelInvitation() {
    if (!user) return;
    if (!confirm(t('inviteCancelConfirm', { name: user.name, email: user.email }))) return;
    setError('');
    const res = await withLoading(() =>
      fetch(`/api/admin/users/${user.id}/cancel-invitation`, { method: 'POST' }),
    );
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      const msg = json.error?.message || t('inviteCancelFailed');
      setError(msg);
      showError('招待の取消に失敗しました');
      return;
    }
    onOpenChange(false);
    showSuccess('招待を取り消しました');
    void onSaved();
  }

  // PR #89: ユーザ削除 (論理削除 + ProjectMember 物理削除)。
  // 2 段階 confirm (意思確認 + 影響告知) で誤操作を防ぐ。
  async function handleDelete() {
    if (!user) return;
    if (!confirm(t('deleteConfirm', { name: user.name, email: user.email }))) return;
    setError('');
    const res = await withLoading(() =>
      fetch(`/api/admin/users/${user.id}`, { method: 'DELETE' }),
    );
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      const msg = json.error?.message || t('deleteFailed');
      setError(msg);
      showError('ユーザの削除に失敗しました');
      return;
    }
    const json = await res.json().catch(() => ({ data: null }));
    const removed = json?.data?.removedMemberships ?? 0;
    alert(t('deleteDone', { count: removed }));
    // feat/account-lock-and-ui-consistency: 作成と挙動統一、即時 close → reload は裏で
    onOpenChange(false);
    showSuccess('ユーザを削除しました');
    void onSaved();
  }

  // ロック表示用の状態判定 (PR #85) — nowAtMount は hook 順序の都合で上部宣言済
  const temporaryLocked
    = !!user.lockedUntil && new Date(user.lockedUntil).getTime() > nowAtMount;
  const isLocked = user.permanentLock || temporaryLocked;
  const canShowUnlockButton = isLocked || user.failedLoginCount > 0;
  // 2026-06-03: 招待中 (パスワード未設定) は有効/無効の切替・ロック・リカバリーが無意味なので、
  //   専用の「招待中」セクション (再送 / 取消) を出し、それ以外のセクションは隠す。
  const isInvited = user.accountStatus === 'invited';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* PR #112: admin ダイアログは大画面で余白過多になりやすいので lg: で拡大、
          縦の overflow は基底が吸収するのでここでは指定不要 */}
      <DialogContent className="max-w-[min(90vw,32rem)] lg:max-w-[min(70vw,44rem)]">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>
            {t('description', { email: user.email })}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          {error && <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}
          <div className="space-y-2">
            <Label>{tField('name')}</Label>
            <Input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              maxLength={NAME_MAX_LENGTH}
              required
            />
          </div>
          <div className="space-y-2">
            <Label>{t('fieldSystemRole')}</Label>
            <select
              value={form.systemRole}
              onChange={(e) => setForm({ ...form, systemRole: e.target.value as 'admin' | 'general' })}
              className={nativeSelectClass}
              // feat/crud-permission-redesign (2026-05-20 追加要件): 自分自身のロール変更禁止
              disabled={user.id === currentUserId}
              title={user.id === currentUserId ? t('selfRoleEditForbidden') : undefined}
            >
              {/* feat/crud-permission-redesign (2026-05-20 追加要件): super_admin は管理テナント所属で
                  テナント側 UI からの選択を禁止 (option 自体を出さない) */}
              {Object.entries(SYSTEM_ROLES)
                .filter(([key]) => key !== 'super_admin')
                .map(([key, label]) => (
                  <option key={key} value={key}>{label}</option>
                ))}
            </select>
            {user.id === currentUserId && (
              <p className="text-xs text-muted-foreground">{t('selfRoleEditForbidden')}</p>
            )}
          </div>
          <div className="space-y-2">
            <Label>{t('fieldAccountStatus')}</Label>
            <select
              value={form.isActive ? 'active' : 'inactive'}
              onChange={(e) => setForm({ ...form, isActive: e.target.value === 'active' })}
              className={nativeSelectClass}
              // 2026-06-03: 招待中 (未受諾) は有効/無効を切り替えられない (受諾後に意味を持つ)
              disabled={isInvited}
              title={isInvited ? t('statusEditInvitedDisabled') : undefined}
            >
              <option value="active">{t('statusActive')}</option>
              <option value="inactive">{t('statusInactive')}</option>
            </select>
            {isInvited && (
              <p className="text-xs text-muted-foreground">{t('statusEditInvitedDisabled')}</p>
            )}
          </div>
          <Button type="submit" className="w-full">{tAction('save')}</Button>
        </form>

        {/* 2026-06-03: アカウント情報 (状態 / 前回ログイン日時 / MFA 有無) — 読み取り専用表示 */}
        <div className="mt-4 space-y-1 rounded-md border border-border bg-muted/30 p-3 text-sm">
          <div className="font-medium">{t('accountInfoSectionTitle')}</div>
          <div className="space-y-1 text-muted-foreground">
            <div>
              {t('accountStatusLabel')}{' '}
              <span className="font-medium text-foreground">
                {user.accountStatus === 'active'
                  ? t('statusActive')
                  : user.accountStatus === 'invited'
                    ? t('statusInvited')
                    : t('statusInactive')}
              </span>
            </div>
            <div>
              {t('lastLoginLabel')}{' '}
              {user.lastLoginAt ? formatDateTimeFull(user.lastLoginAt) : t('lastLoginNever')}
            </div>
            <div>
              {t('mfaLabel')}{' '}
              <span className={user.mfaEnabled ? 'font-medium text-foreground' : ''}>
                {user.mfaEnabled ? t('mfaEnabledYes') : t('mfaEnabledNo')}
              </span>
            </div>
          </div>
        </div>

        {/* 2026-06-03: 招待中セクション (招待メール再送 / 招待取消)。招待中ユーザのみ表示。 */}
        {isInvited && (
          <div className="mt-4 space-y-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-700 dark:bg-amber-950/40">
            <div className="font-medium text-amber-900 dark:text-amber-200">{t('inviteSectionTitle')}</div>
            <div className="text-xs text-amber-800 dark:text-amber-300">{t('inviteSectionDescription')}</div>
            <Button
              type="button"
              variant="outline"
              className="w-full"
              onClick={handleResendInvitation}
            >
              {t('inviteResendButton')}
            </Button>
            <Button
              type="button"
              variant="outline"
              className="w-full border-destructive/40 text-destructive hover:bg-destructive/10"
              onClick={handleCancelInvitation}
            >
              {t('inviteCancelButton')}
            </Button>
          </div>
        )}

        {/* PR #85: ロック情報 + 解除ボタン (招待中は対象外) */}
        {!isInvited && (
        <div className="mt-4 space-y-2 rounded-md border border-border bg-muted/30 p-3 text-sm">
          <div className="font-medium">{t('lockSectionTitle')}</div>
          <div className="space-y-1 text-muted-foreground">
            <div>
              {t('loginFailedCount')}{' '}
              <span className={user.failedLoginCount > 0 ? 'text-destructive font-medium' : ''}>
                {t('failedCountUnit', { count: user.failedLoginCount })}
              </span>
            </div>
            <div>
              {t('temporaryLockLabel')}{' '}
              {temporaryLocked
                ? t('temporaryLockValue', { unlockAt: formatDateTimeFull(user.lockedUntil!) })
                : t('temporaryLockNone')}
            </div>
            <div>
              {t('permanentLockLabel')}{' '}
              {user.permanentLock ? t('permanentLockYes') : t('permanentLockNo')}
            </div>
          </div>
          {canShowUnlockButton && (
            <Button
              type="button"
              variant="outline"
              className="w-full"
              onClick={handleUnlock}
            >
              {t('unlockButton')}
            </Button>
          )}
        </div>
        )}

        {/* 2026-06-03: リカバリーコード再発行 (MFA 復旧導線)。MFA 設定済みユーザのみ表示 */}
        {user.mfaEnabled && (
          <div className="mt-4 space-y-2 rounded-md border border-border bg-muted/30 p-3 text-sm">
            <div className="font-medium">{t('recoverySectionTitle')}</div>
            <div className="text-xs text-muted-foreground">{t('recoverySectionDescription')}</div>
            {recoveryCodes && (
              <div className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-3 dark:border-amber-700 dark:bg-amber-950/40">
                <div className="text-xs font-medium text-amber-900 dark:text-amber-200">
                  {t('recoveryCodesTitle')}
                </div>
                <ul className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-sm">
                  {recoveryCodes.map((code) => (
                    <li key={code}>{code}</li>
                  ))}
                </ul>
                <div className="text-xs text-amber-800 dark:text-amber-300">{t('recoveryCodesHint')}</div>
              </div>
            )}
            <Button
              type="button"
              variant="outline"
              className="w-full"
              onClick={handleReissueRecovery}
            >
              {t('recoveryReissueButton')}
            </Button>
          </div>
        )}

        {/* PR #89: 削除ボタン (論理削除 + ProjectMember 物理削除)。招待中は「招待取消」を使うため非表示。 */}
        {!isInvited && (
        <div className="mt-4 space-y-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm">
          <div className="font-medium text-destructive">{t('dangerZoneTitle')}</div>
          <div className="space-y-1 text-xs text-muted-foreground">
            {t('dangerZoneDescription')}
          </div>
          <Button
            type="button"
            variant="outline"
            className="w-full border-destructive/40 text-destructive hover:bg-destructive/10"
            onClick={handleDelete}
          >
            {t('deleteButton')}
          </Button>
        </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
