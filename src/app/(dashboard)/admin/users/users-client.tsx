'use client';

/**
 * ユーザ管理画面 (システム管理者専用) のクライアントコンポーネント。
 *
 * 役割:
 *   - 全ユーザの一覧表示 (アクティブ/非アクティブ含む)
 *   - 新規ユーザ発行ダイアログ (検証メール送信)
 *   - 既存ユーザの編集 (氏名 / システムロール / 有効状態)
 *   - リカバリーコード再発行
 *
 * 認可: ページ側 (page.tsx) で systemRole='admin' を確認済の前提。
 * API: /api/admin/users (GET/POST), /api/admin/users/[userId] (PATCH)
 *
 * 関連: SPECIFICATION.md (ユーザ管理画面)
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useLoading } from '@/components/loading-overlay';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { nativeSelectClass } from '@/components/ui/native-select-style';
import { UserEditDialog } from '@/components/dialogs/user-edit-dialog';
import { SYSTEM_ROLES } from '@/types';
import type { UserDTO } from '@/services/user.service';
// PR #117 → PR #119: session 連携フォーマッタ (TZ/locale はユーザ設定を反映)
import { useFormatters } from '@/lib/use-formatters';

type Props = {
  initialUsers: UserDTO[];
};

export function UsersClient({ initialUsers }: Props) {
  const tAction = useTranslations('action');
  const t = useTranslations('admin.users');
  const router = useRouter();
  const { withLoading } = useLoading();
  // PR #119: session 連携フォーマッタ
  const { formatDate, formatDateTimeFull } = useFormatters();
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState('');
  // PR #59 Req 3: 行クリックで編集ダイアログ
  const [editingUser, setEditingUser] = useState<UserDTO | null>(null);
  // PR #85: ロック判定用の「今」スナップショット。
  // Date.now() は render 中に呼べない (react-hooks/purity)。マウント時 1 回の評価で、
  // ユーザ一覧画面を開いている間にロック表示が自動で切り替わる必要はない想定。
  const [nowAtMount] = useState(() => Date.now());

  const [form, setForm] = useState({
    name: '',
    email: '',
    systemRole: 'general' as 'admin' | 'general',
  });

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError('');

    const res = await withLoading(() =>
      fetch('/api/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      }),
    );

    const json = await res.json();

    if (!res.ok) {
      const code = json.error?.code;
      if (code === 'DUPLICATE_EMAIL') {
        setError(t('duplicateEmail'));
      } else if (code === 'EMAIL_SEND_FAILED') {
        setError(t('invitationSendFailed'));
      } else if (code === 'VALIDATION_ERROR') {
        setError(json.error?.details?.[0]?.message || t('validationError'));
      } else {
        setError(json.error?.message || t('registrationFailed'));
      }
      return;
    }

    setSuccess(true);
    router.refresh();
  }

  function handleClose() {
    setSuccess(false);
    setIsDialogOpen(false);
    setError('');
    setForm({ name: '', email: '', systemRole: 'general' });
  }

  // PR #89: 非アクティブユーザの手動ロック (vercel cron の日次実行に加え、手動でも実行可能)。
  // feat/account-lock 改修: 旧 (論理削除) → 新 (isActive=false ロック) へ方針変更。
  // 過去ナレッジ等の作成者表示を維持しつつ、ログインだけ封じる折衷。復帰は admin が
  // 当該ユーザ行の編集ダイアログから isActive をトグル。
  async function handleManualLockInactive() {
    if (!confirm(t('lockInactiveConfirm'))) return;
    const res = await withLoading(() =>
      fetch('/api/admin/users/lock-inactive', { method: 'POST' }),
    );
    if (!res.ok) {
      alert(t('lockInactiveFailed'));
      return;
    }
    const json = await res.json().catch(() => ({ data: null }));
    const count = json?.data?.lockedUserIds?.length ?? 0;
    alert(t('lockInactiveDone', { count }));
    router.refresh();
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">{t('title')}</h2>
        <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={handleManualLockInactive}>
          {t('lockInactive')}
        </Button>
        <Dialog open={isDialogOpen} onOpenChange={(open) => { if (!open) handleClose(); else setIsDialogOpen(true); }}>
          <DialogTrigger className="inline-flex shrink-0 items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-xs hover:bg-primary/90">{t('createUser')}</DialogTrigger>
          {/* PR #112: 大画面での余白過多対策 (基底で scroll 対応済) */}
          <DialogContent className="max-w-[min(90vw,32rem)] lg:max-w-[min(70vw,44rem)]">
            {success ? (
              <>
                <DialogHeader>
                  <DialogTitle>{t('invitationSent')}</DialogTitle>
                  <DialogDescription>
                    {t('invitationSentBody', { email: form.email })}
                  </DialogDescription>
                </DialogHeader>
                <Button onClick={handleClose}>{tAction('close')}</Button>
              </>
            ) : (
              <>
                <DialogHeader>
                  <DialogTitle>{t('createUser')}</DialogTitle>
                  <DialogDescription>
                    {t('createUserDescription')}
                  </DialogDescription>
                </DialogHeader>
                <form onSubmit={handleCreate} className="space-y-4">
                  {error && (
                    <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>
                  )}
                  <div className="space-y-2">
                    <Label htmlFor="name">{t('fieldUserName')}</Label>
                    <Input
                      id="name"
                      value={form.name}
                      onChange={(e) => setForm({ ...form, name: e.target.value })}
                      maxLength={100}
                      required
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="email">{t('fieldEmail')}</Label>
                    <Input
                      id="email"
                      type="email"
                      value={form.email}
                      onChange={(e) => setForm({ ...form, email: e.target.value })}
                      required
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="role">{t('fieldSystemRole')}</Label>
                    <select value={form.systemRole} onChange={(e) => setForm({ ...form, systemRole: e.target.value as 'admin' | 'general' })} className={nativeSelectClass}>
                      {Object.entries(SYSTEM_ROLES).map(([key, label]) => (
                        <option key={key} value={key}>{label}</option>
                      ))}
                    </select>
                  </div>
                  <Button type="submit" className="w-full">
                    {t('sendInvitation')}
                  </Button>
                </form>
              </>
            )}
          </DialogContent>
        </Dialog>
        </div>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('fieldUserName')}</TableHead>
            <TableHead>{t('fieldEmail')}</TableHead>
            <TableHead>{t('columnRole')}</TableHead>
            <TableHead>{t('columnStatus')}</TableHead>
            {/*
              PR #85 / PR #116: 認証ロック状態
              - パスワード失敗ロック: failedLoginCount 5 回で一時ロック (30 分)
                ⚠️ 旧コメントには「3 回目で permanentLock」とあったが PR-η 調査で
                  実装されていないバグ判明 (§5.28)。永続ロック化は §11 T-20 で実装予定。
                  現状は永続ロック発火経路なし、一時ロックを延々繰り返す挙動になっている。
              - MFA 失敗ロック (PR #116): mfaFailedCount 3 回で一時ロック (30 分) / recovery code で自己解除可
              - 1 列集約: tooltip で内訳 (原因・解除予定・失敗回数) を表示
            */}
            <TableHead>{t('columnAuthLock')}</TableHead>
            <TableHead>{t('columnCreatedAt')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {initialUsers.map((user) => {
            const pwTemporaryLocked
              = !!user.lockedUntil && new Date(user.lockedUntil).getTime() > nowAtMount;
            // PR #116: MFA ロック (パスワードロックとは別系統)
            const mfaTemporaryLocked
              = !!user.mfaLockedUntil && new Date(user.mfaLockedUntil).getTime() > nowAtMount;

            // PR #116 A 案: tooltip に全情報を集約。表示優先度:
            //   永続 > パスワード一時 > MFA 一時 > パスワード失敗カウント > MFA 失敗カウント > —
            const lockBadgeProps = (() => {
              if (user.permanentLock) {
                return {
                  variant: 'destructive' as const,
                  label: t('permanentLock'),
                  title: t('permanentLockTitle'),
                };
              }
              if (pwTemporaryLocked) {
                return {
                  variant: 'destructive' as const,
                  label: t('temporaryLockPassword'),
                  title: t('temporaryLockPasswordTitle', {
                    count: user.failedLoginCount,
                    unlockAt: formatDateTimeFull(user.lockedUntil!),
                  }),
                };
              }
              if (mfaTemporaryLocked) {
                return {
                  variant: 'destructive' as const,
                  label: t('temporaryLockMfa'),
                  title: t('temporaryLockMfaTitle', {
                    unlockAt: formatDateTimeFull(user.mfaLockedUntil!),
                  }),
                };
              }
              if (user.failedLoginCount > 0) {
                return {
                  variant: 'secondary' as const,
                  label: t('pwFailedBadge', { count: user.failedLoginCount }),
                  title: t('pwFailedBadgeTitle'),
                };
              }
              if (user.mfaFailedCount > 0) {
                return {
                  variant: 'secondary' as const,
                  label: t('mfaFailedBadge', { count: user.mfaFailedCount }),
                  title: t('mfaFailedBadgeTitle'),
                };
              }
              return null;
            })();

            return (
              <TableRow
                key={user.id}
                className="cursor-pointer hover:bg-muted"
                onClick={() => setEditingUser(user)}
              >
                <TableCell className="font-medium">{user.name}</TableCell>
                <TableCell>{user.email}</TableCell>
                <TableCell>
                  <Badge variant={user.systemRole === 'admin' ? 'default' : 'secondary'}>
                    {SYSTEM_ROLES[user.systemRole as keyof typeof SYSTEM_ROLES] || user.systemRole}
                  </Badge>
                </TableCell>
                <TableCell>
                  <Badge variant={user.isActive ? 'default' : 'destructive'}>
                    {user.isActive ? t('statusActive') : t('statusInactive')}
                  </Badge>
                </TableCell>
                <TableCell>
                  {lockBadgeProps ? (
                    <Badge variant={lockBadgeProps.variant} title={lockBadgeProps.title}>
                      {lockBadgeProps.label}
                    </Badge>
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell>{formatDate(user.createdAt)}</TableCell>
              </TableRow>
            );
          })}
          {initialUsers.length === 0 && (
            <TableRow>
              <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                {t('noUsers')}
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>

      <UserEditDialog
        user={editingUser}
        open={editingUser != null}
        onOpenChange={(v) => { if (!v) setEditingUser(null); }}
        onSaved={async () => { router.refresh(); }}
      />
    </div>
  );
}
