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
 */
export function UserEditDialog({
  user,
  open,
  onOpenChange,
  onSaved,
}: {
  user: UserDTO | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSaved: () => Promise<void> | void;
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
            >
              {Object.entries(SYSTEM_ROLES).map(([key, label]) => (
                <option key={key} value={key}>{label}</option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <Label>{t('fieldAccountStatus')}</Label>
            <select
              value={form.isActive ? 'active' : 'inactive'}
              onChange={(e) => setForm({ ...form, isActive: e.target.value === 'active' })}
              className={nativeSelectClass}
            >
              <option value="active">{t('statusActive')}</option>
              <option value="inactive">{t('statusInactive')}</option>
            </select>
          </div>
          <Button type="submit" className="w-full">{tAction('save')}</Button>
        </form>

        {/* PR #85: ロック情報 + 解除ボタン */}
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

        {/* PR #89: 削除ボタン (論理削除 + ProjectMember 物理削除) */}
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
      </DialogContent>
    </Dialog>
  );
}
