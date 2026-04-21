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

type Props = {
  initialUsers: UserDTO[];
};

export function UsersClient({ initialUsers }: Props) {
  const t = useTranslations('action');
  const router = useRouter();
  const { withLoading } = useLoading();
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

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">ユーザ管理</h2>
        <Dialog open={isDialogOpen} onOpenChange={(open) => { if (!open) handleClose(); else setIsDialogOpen(true); }}>
          <DialogTrigger className="inline-flex shrink-0 items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-xs hover:bg-primary/90">新規ユーザ登録</DialogTrigger>
          <DialogContent className="max-w-md">
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

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>ユーザ名</TableHead>
            <TableHead>メールアドレス</TableHead>
            <TableHead>ロール</TableHead>
            <TableHead>状態</TableHead>
            {/* PR #85: ロック状態 (ログイン失敗 5 回で一時ロック、admin が永続ロック可能) */}
            <TableHead>ロック</TableHead>
            <TableHead>作成日</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {initialUsers.map((user) => {
            const temporaryLocked
              = !!user.lockedUntil && new Date(user.lockedUntil).getTime() > nowAtMount;
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
                  {user.permanentLock ? (
                    <Badge variant="destructive" title="管理者により永続ロック中">永続ロック</Badge>
                  ) : temporaryLocked ? (
                    <Badge
                      variant="destructive"
                      title={`解除予定: ${new Date(user.lockedUntil!).toLocaleString('ja-JP')}`}
                    >
                      一時ロック
                    </Badge>
                  ) : user.failedLoginCount > 0 ? (
                    <Badge variant="secondary" title="ログイン失敗カウント (5 回で一時ロック)">
                      失敗 {user.failedLoginCount}/5
                    </Badge>
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell>{new Date(user.createdAt).toLocaleDateString('ja-JP')}</TableCell>
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

      <UserEditDialog
        user={editingUser}
        open={editingUser != null}
        onOpenChange={(v) => { if (!v) setEditingUser(null); }}
        onSaved={async () => { router.refresh(); }}
      />
    </div>
  );
}
