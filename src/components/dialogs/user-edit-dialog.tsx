'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useLoading } from '@/components/loading-overlay';
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
// PR #117: JST 固定タイムゾーン描画 (ハイドレーション安全)
import { formatDateTimeFull } from '@/lib/format';

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
  const t = useTranslations('action');
  const tField = useTranslations('field');
  const { withLoading } = useLoading();
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
      setError(json.error?.message || '更新に失敗しました');
      return;
    }
    await onSaved();
    onOpenChange(false);
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
      setError(json.error?.message || 'ロック解除に失敗しました');
      return;
    }
    await onSaved();
    onOpenChange(false);
  }

  // PR #89: ユーザ削除 (論理削除 + ProjectMember 物理削除)。
  // 2 段階 confirm (意思確認 + 影響告知) で誤操作を防ぐ。
  async function handleDelete() {
    if (!user) return;
    if (!confirm(
      `「${user.name}」(${user.email}) を削除しますか？\n\n`
      + 'この操作でユーザは即時ログイン不可となり、全プロジェクトの\n'
      + 'メンバー情報から削除されます。\n\n'
      + '※ 過去のタスク担当・リスク起票等の履歴は保全されます。',
    )) return;
    setError('');
    const res = await withLoading(() =>
      fetch(`/api/admin/users/${user.id}`, { method: 'DELETE' }),
    );
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      setError(json.error?.message || '削除に失敗しました');
      return;
    }
    const json = await res.json().catch(() => ({ data: null }));
    const removed = json?.data?.removedMemberships ?? 0;
    alert(`削除しました (紐づくプロジェクトメンバー ${removed} 件も削除)`);
    await onSaved();
    onOpenChange(false);
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
          <DialogTitle>ユーザ編集</DialogTitle>
          <DialogDescription>
            {user.email} の情報を編集します。
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
            <Label>システムロール</Label>
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
            <Label>アカウント状態</Label>
            <select
              value={form.isActive ? 'active' : 'inactive'}
              onChange={(e) => setForm({ ...form, isActive: e.target.value === 'active' })}
              className={nativeSelectClass}
            >
              <option value="active">有効</option>
              <option value="inactive">無効</option>
            </select>
          </div>
          <Button type="submit" className="w-full">{t('save')}</Button>
        </form>

        {/* PR #85: ロック情報 + 解除ボタン */}
        <div className="mt-4 space-y-2 rounded-md border border-border bg-muted/30 p-3 text-sm">
          <div className="font-medium">ログインロック情報</div>
          <div className="space-y-1 text-muted-foreground">
            <div>
              ログイン失敗回数:{' '}
              <span className={user.failedLoginCount > 0 ? 'text-destructive font-medium' : ''}>
                {user.failedLoginCount} 回
              </span>
            </div>
            <div>
              一時ロック:{' '}
              {temporaryLocked
                ? `${formatDateTimeFull(user.lockedUntil!)} まで`
                : 'なし'}
            </div>
            <div>永続ロック: {user.permanentLock ? 'あり (要解除)' : 'なし'}</div>
          </div>
          {canShowUnlockButton && (
            <Button
              type="button"
              variant="outline"
              className="w-full"
              onClick={handleUnlock}
            >
              ロック解除 (失敗カウントリセット)
            </Button>
          )}
        </div>

        {/* PR #89: 削除ボタン (論理削除 + ProjectMember 物理削除) */}
        <div className="mt-4 space-y-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm">
          <div className="font-medium text-destructive">危険な操作</div>
          <div className="space-y-1 text-xs text-muted-foreground">
            ユーザを削除すると即時ログイン不可となり、全プロジェクトの
            メンバー情報から削除されます。過去の作業履歴 (担当タスク・起票リスク等) は保全されます。
          </div>
          <Button
            type="button"
            variant="outline"
            className="w-full border-destructive/40 text-destructive hover:bg-destructive/10"
            onClick={handleDelete}
          >
            このユーザを削除
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
