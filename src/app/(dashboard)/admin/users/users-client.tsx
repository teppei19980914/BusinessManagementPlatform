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

/**
 * PR #128c: 認証ロックバッジの props を算出する (PC テーブル / モバイルカード両方で共用)。
 * 優先度: 永続 > パスワード一時 > MFA 一時 > パスワード失敗カウント > MFA 失敗カウント > null
 * PR #85 / PR #116 の元ロジックをそのまま関数化したもの (挙動変更なし)。
 */
type LockBadgeProps = {
  variant: 'default' | 'destructive' | 'secondary' | 'outline';
  label: string;
  title: string;
};
function getLockBadgeProps(
  user: UserDTO,
  nowAtMount: number,
  formatDateTimeFull: (iso: string) => string,
): LockBadgeProps | null {
  const pwTemporaryLocked
    = !!user.lockedUntil && new Date(user.lockedUntil).getTime() > nowAtMount;
  const mfaTemporaryLocked
    = !!user.mfaLockedUntil && new Date(user.mfaLockedUntil).getTime() > nowAtMount;
  if (user.permanentLock) {
    return {
      variant: 'destructive',
      label: '永続ロック',
      title: '管理者により永続ロック中 (admin の手動解除のみ可)',
    };
  }
  if (pwTemporaryLocked) {
    return {
      variant: 'destructive',
      label: '一時ロック (パスワード)',
      title:
        `原因: パスワード連続失敗 (${user.failedLoginCount}/5)\n`
        + `解除予定: ${formatDateTimeFull(user.lockedUntil!)}\n`
        + `解除手段: 時間経過 / admin 手動解除`,
    };
  }
  if (mfaTemporaryLocked) {
    return {
      variant: 'destructive',
      label: '一時ロック (MFA)',
      title:
        `原因: MFA コード連続失敗 (3/3 回)\n`
        + `解除予定: ${formatDateTimeFull(user.mfaLockedUntil!)}\n`
        + `解除手段: 時間経過 / リカバリーコード入力 / admin 手動解除`,
    };
  }
  if (user.failedLoginCount > 0) {
    return {
      variant: 'secondary',
      label: `PW 失敗 ${user.failedLoginCount}/5`,
      title: `ログインパスワード失敗カウント (5 回で 30 分一時ロック)`,
    };
  }
  if (user.mfaFailedCount > 0) {
    return {
      variant: 'secondary',
      label: `MFA 失敗 ${user.mfaFailedCount}/3`,
      title: `MFA コード失敗カウント (3 回で 30 分一時ロック)`,
    };
  }
  return null;
}

export function UsersClient({ initialUsers }: Props) {
  const t = useTranslations('action');
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
        setError('このメールアドレスは既に登録されています。別のメールアドレスを使用してください。');
      } else if (code === 'EMAIL_SEND_FAILED') {
        setError(
          '招待メールの送信に失敗しました。メールアドレスに誤りがないか確認し、再度お試しください。',
        );
      } else if (code === 'VALIDATION_ERROR') {
        setError(
          json.error?.details?.[0]?.message || '入力内容に不備があります。確認してください。',
        );
      } else {
        setError(json.error?.message || '登録に失敗しました。しばらくしてから再度お試しください。');
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

  // PR #89: 非アクティブユーザの手動クリーンアップ (vercel cron の日次実行に加え、手動でも実行可能)
  async function handleManualCleanup() {
    if (!confirm(
      '最終ログインから 30 日以上経過した非アクティブユーザを一括削除します。\n'
      + 'admin ユーザは対象外です。削除されたユーザの ProjectMember も\n'
      + '同時に物理削除されます。実行しますか？',
    )) return;
    const res = await withLoading(() =>
      fetch('/api/admin/users/cleanup-inactive', { method: 'POST' }),
    );
    if (!res.ok) {
      alert('クリーンアップ実行に失敗しました');
      return;
    }
    const json = await res.json().catch(() => ({ data: null }));
    const count = json?.data?.deletedUserIds?.length ?? 0;
    const removed = json?.data?.removedMembershipsTotal ?? 0;
    alert(`クリーンアップ完了\n\n削除ユーザ: ${count} 件\nProjectMember 削除: ${removed} 件`);
    router.refresh();
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">ユーザ管理</h2>
        <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={handleManualCleanup}>
          非アクティブユーザを整理
        </Button>
        <Dialog open={isDialogOpen} onOpenChange={(open) => { if (!open) handleClose(); else setIsDialogOpen(true); }}>
          <DialogTrigger className="inline-flex shrink-0 items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-xs hover:bg-primary/90">新規ユーザ登録</DialogTrigger>
          {/* PR #112: 大画面での余白過多対策 (基底で scroll 対応済) */}
          <DialogContent className="max-w-[min(90vw,32rem)] lg:max-w-[min(70vw,44rem)]">
            {success ? (
              <>
                <DialogHeader>
                  <DialogTitle>招待メールを送信しました</DialogTitle>
                  <DialogDescription>
                    {form.email} にパスワード設定用のリンクを送信しました。
                    ユーザがリンクからパスワードを設定すると、アカウントが有効化されます。
                  </DialogDescription>
                </DialogHeader>
                <Button onClick={handleClose}>{t('close')}</Button>
              </>
            ) : (
              <>
                <DialogHeader>
                  <DialogTitle>新規ユーザ登録</DialogTitle>
                  <DialogDescription>
                    ユーザ情報を入力してください。登録後、パスワード設定用の招待メールが送信されます。
                  </DialogDescription>
                </DialogHeader>
                <form onSubmit={handleCreate} className="space-y-4">
                  {error && (
                    <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>
                  )}
                  <div className="space-y-2">
                    <Label htmlFor="name">ユーザ名</Label>
                    <Input
                      id="name"
                      value={form.name}
                      onChange={(e) => setForm({ ...form, name: e.target.value })}
                      maxLength={100}
                      required
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="email">メールアドレス</Label>
                    <Input
                      id="email"
                      type="email"
                      value={form.email}
                      onChange={(e) => setForm({ ...form, email: e.target.value })}
                      required
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="role">システムロール</Label>
                    <select value={form.systemRole} onChange={(e) => setForm({ ...form, systemRole: e.target.value as 'admin' | 'general' })} className={nativeSelectClass}>
                      {Object.entries(SYSTEM_ROLES).map(([key, label]) => (
                        <option key={key} value={key}>{label}</option>
                      ))}
                    </select>
                  </div>
                  <Button type="submit" className="w-full">
                    招待メールを送信
                  </Button>
                </form>
              </>
            )}
          </DialogContent>
        </Dialog>
        </div>
      </div>

      {/* PR #128c: PC は既存テーブル、モバイルはカード形式。lockBadgeProps は両ビューで共有 helper (getLockBadgeProps) を使用。 */}
      {/* PC (md+): 既存テーブル */}
      <div className="hidden md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>ユーザ名</TableHead>
              <TableHead>メールアドレス</TableHead>
              <TableHead>ロール</TableHead>
              <TableHead>状態</TableHead>
              {/*
                PR #85 / PR #116: 認証ロック状態
                - パスワード失敗ロック: failedLoginCount 5 回で一時ロック (30 分) / 3 回目で permanentLock
                - MFA 失敗ロック (PR #116): mfaFailedCount 3 回で一時ロック (30 分) / recovery code で自己解除可
                - 1 列集約: tooltip で内訳 (原因・解除予定・失敗回数) を表示
              */}
              <TableHead>認証ロック</TableHead>
              <TableHead>作成日</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {initialUsers.map((user) => {
              const lockBadgeProps = getLockBadgeProps(user, nowAtMount, formatDateTimeFull);
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
                      {user.isActive ? '有効' : '無効'}
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
                  ユーザが登録されていません
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {/* モバイル (md 未満): カード形式 */}
      <div className="space-y-2 md:hidden" role="list" aria-label="ユーザ一覧">
        {initialUsers.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">ユーザが登録されていません</p>
        ) : (
          initialUsers.map((user) => {
            const lockBadgeProps = getLockBadgeProps(user, nowAtMount, formatDateTimeFull);
            return (
              <div
                key={user.id}
                role="listitem"
                onClick={() => setEditingUser(user)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setEditingUser(user);
                  }
                }}
                tabIndex={0}
                className="cursor-pointer rounded-md border bg-card p-3 text-sm transition-colors hover:bg-muted"
              >
                <div className="mb-2 flex flex-wrap items-center gap-1.5">
                  <span className="font-medium">{user.name}</span>
                  <Badge variant={user.systemRole === 'admin' ? 'default' : 'secondary'} className="text-[10px]">
                    {SYSTEM_ROLES[user.systemRole as keyof typeof SYSTEM_ROLES] || user.systemRole}
                  </Badge>
                  <Badge variant={user.isActive ? 'default' : 'destructive'} className="text-[10px]">
                    {user.isActive ? '有効' : '無効'}
                  </Badge>
                </div>
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                  <dt className="text-xs text-muted-foreground">メール</dt>
                  <dd className="text-xs break-all">{user.email}</dd>
                  <dt className="text-xs text-muted-foreground">認証ロック</dt>
                  <dd>
                    {lockBadgeProps ? (
                      <Badge variant={lockBadgeProps.variant} title={lockBadgeProps.title} className="text-[10px]">
                        {lockBadgeProps.label}
                      </Badge>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </dd>
                  <dt className="text-xs text-muted-foreground">作成日</dt>
                  <dd className="text-xs">{formatDate(user.createdAt)}</dd>
                </dl>
              </div>
            );
          })
        )}
      </div>

      <UserEditDialog
        user={editingUser}
        open={editingUser != null}
        onOpenChange={(v) => { if (!v) setEditingUser(null); }}
        onSaved={async () => { router.refresh(); }}
      />
    </div>
  );
}
