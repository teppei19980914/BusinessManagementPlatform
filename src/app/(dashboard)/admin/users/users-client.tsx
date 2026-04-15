'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { SYSTEM_ROLES } from '@/types';
import type { UserDTO } from '@/services/user.service';

type Props = {
  initialUsers: UserDTO[];
};

export function UsersClient({ initialUsers }: Props) {
  const router = useRouter();
  const { withLoading } = useLoading();
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [error, setError] = useState('');

  const [form, setForm] = useState({
    name: '',
    email: '',
    password: '',
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
          '検証メールの送信に失敗しました。メールアドレスに誤りがないか確認し、再度お試しください。',
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

    setRecoveryCodes(json.data.recoveryCodes);
    router.refresh();
  }

  function handleCloseRecoveryCodes() {
    setRecoveryCodes(null);
    setIsDialogOpen(false);
    setForm({ name: '', email: '', password: '', systemRole: 'general' });
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">ユーザ管理</h2>
        <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
          <DialogTrigger className="inline-flex shrink-0 items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-xs hover:bg-primary/90">新規ユーザ登録</DialogTrigger>
          <DialogContent className="max-w-md">
            {recoveryCodes ? (
              <>
                <DialogHeader>
                  <DialogTitle>リカバリーコード</DialogTitle>
                  <DialogDescription>
                    このコードを安全な場所に保管してください。再表示はできません。
                  </DialogDescription>
                </DialogHeader>
                <div className="rounded-md bg-gray-50 p-4 font-mono text-sm">
                  {recoveryCodes.map((code, i) => (
                    <div key={i}>
                      {String(i + 1).padStart(2, ' ')}. {code}
                    </div>
                  ))}
                </div>
                <Button onClick={handleCloseRecoveryCodes}>確認しました</Button>
              </>
            ) : (
              <>
                <DialogHeader>
                  <DialogTitle>新規ユーザ登録</DialogTitle>
                  <DialogDescription>ユーザ情報を入力してください。</DialogDescription>
                </DialogHeader>
                <form onSubmit={handleCreate} className="space-y-4">
                  {error && (
                    <div className="rounded-md bg-red-50 p-3 text-sm text-red-600">{error}</div>
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
                    <Label htmlFor="password">初期パスワード</Label>
                    <Input
                      id="password"
                      type="password"
                      value={form.password}
                      onChange={(e) => setForm({ ...form, password: e.target.value })}
                      required
                    />
                    <p className="text-xs text-gray-500">
                      10文字以上、英大文字・英小文字・数字・記号のうち3種以上
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="role">システムロール</Label>
                    <Select
                      value={form.systemRole}
                      onValueChange={(v) =>
                        setForm({ ...form, systemRole: v as 'admin' | 'general' })
                      }
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {Object.entries(SYSTEM_ROLES).map(([key, label]) => (
                          <SelectItem key={key} value={key}>
                            {label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <Button type="submit" className="w-full">
                    登録
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
            <TableHead>作成日</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {initialUsers.map((user) => (
            <TableRow key={user.id}>
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
              <TableCell>{new Date(user.createdAt).toLocaleDateString('ja-JP')}</TableCell>
            </TableRow>
          ))}
          {initialUsers.length === 0 && (
            <TableRow>
              <TableCell colSpan={5} className="py-8 text-center text-gray-500">
                ユーザが登録されていません
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
