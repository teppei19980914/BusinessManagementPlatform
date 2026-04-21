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

  // Derived State パターン (useEffect 不要): user が切り替わったら form 同期
  const [prevUserId, setPrevUserId] = useState<string | null>(user?.id ?? null);
  if (user && user.id !== prevUserId) {
    setPrevUserId(user.id);
    setForm({
      name: user.name,
      systemRole: user.systemRole as 'admin' | 'general',
      isActive: user.isActive,
    });
    setError('');
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
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
      </DialogContent>
    </Dialog>
  );
}
