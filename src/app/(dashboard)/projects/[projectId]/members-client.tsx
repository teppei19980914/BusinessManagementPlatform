'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useLoading } from '@/components/loading-overlay';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { PROJECT_ROLES } from '@/types';
import type { MemberDTO } from '@/services/member.service';
import type { UserDTO } from '@/services/user.service';

type Props = {
  projectId: string;
  members: MemberDTO[];
  allUsers: UserDTO[];
  isAdmin: boolean;
};

export function MembersClient({ projectId, members, allUsers, isAdmin }: Props) {
  const router = useRouter();
  const { withLoading } = useLoading();
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [addForm, setAddForm] = useState({ userId: '', projectRole: 'member' });
  const [addError, setAddError] = useState('');

  // メンバー追加候補（既にメンバーのユーザを除外）
  const memberUserIds = new Set(members.map((m) => m.userId));
  const availableUsers = allUsers.filter((u) => !memberUserIds.has(u.id) && u.isActive);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setAddError('');
    if (!addForm.userId) {
      setAddError('ユーザを選択してください');
      return;
    }

    const res = await withLoading(() =>
      fetch(`/api/projects/${projectId}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(addForm),
      }),
    );

    if (!res.ok) {
      const json = await res.json();
      setAddError(json.error?.message || 'メンバー追加に失敗しました');
      return;
    }

    setIsAddOpen(false);
    setAddForm({ userId: '', projectRole: 'member' });
    router.refresh();
  }

  async function handleRoleChange(memberId: string, newRole: string) {
    await withLoading(() =>
      fetch(`/api/projects/${projectId}/members/${memberId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectRole: newRole }),
      }),
    );
    router.refresh();
  }

  async function handleRemove(memberId: string, userName: string) {
    if (!confirm(`${userName} をプロジェクトメンバーから解除しますか？`)) return;
    await withLoading(() =>
      fetch(`/api/projects/${projectId}/members/${memberId}`, {
        method: 'DELETE',
      }),
    );
    router.refresh();
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold">メンバー一覧（{members.length}名）</h3>
        {isAdmin && (
          <Dialog open={isAddOpen} onOpenChange={setIsAddOpen}>
            <DialogTrigger className="inline-flex shrink-0 items-center justify-center rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground shadow-xs hover:bg-primary/90">
              メンバー追加
            </DialogTrigger>
            <DialogContent className="max-w-md">
              <DialogHeader>
                <DialogTitle>メンバー追加</DialogTitle>
                <DialogDescription>プロジェクトに追加するユーザとロールを選択してください。</DialogDescription>
              </DialogHeader>
              <form onSubmit={handleAdd} className="space-y-4">
                {addError && (
                  <div className="rounded-md bg-red-50 p-3 text-sm text-red-600">{addError}</div>
                )}
                <div className="space-y-2">
                  <Label>ユーザ</Label>
                  <select value={addForm.userId} onChange={(e) => setAddForm({ ...addForm, userId: e.target.value })} className="flex h-8 w-full items-center rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50" required>
                    <option value="">ユーザを選択...</option>
                    {availableUsers.map((u) => (
                      <option key={u.id} value={u.id}>{u.name}（{u.email}）</option>
                    ))}
                  </select>
                </div>
                <div className="space-y-2">
                  <Label>プロジェクトロール</Label>
                  <select value={addForm.projectRole} onChange={(e) => setAddForm({ ...addForm, projectRole: e.target.value })} className="flex h-8 w-full items-center rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50">
                    {Object.entries(PROJECT_ROLES).map(([key, label]) => (
                      <option key={key} value={key}>{label}</option>
                    ))}
                  </select>
                </div>
                <Button type="submit" className="w-full">追加</Button>
              </form>
            </DialogContent>
          </Dialog>
        )}
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>ユーザ名</TableHead>
            <TableHead>メールアドレス</TableHead>
            <TableHead>ロール</TableHead>
            <TableHead>追加日</TableHead>
            {isAdmin && <TableHead className="w-24">操作</TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {members.map((m) => (
            <TableRow key={m.id}>
              <TableCell className="font-medium">{m.userName}</TableCell>
              <TableCell>{m.userEmail}</TableCell>
              <TableCell>
                {isAdmin ? (
                  <Select
                    value={m.projectRole}
                    onValueChange={(v) => v && handleRoleChange(m.id, v)}
                  >
                    <SelectTrigger className="w-32">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.entries(PROJECT_ROLES).map(([key, label]) => (
                        <SelectItem key={key} value={key}>{label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Badge variant="secondary">
                    {PROJECT_ROLES[m.projectRole as keyof typeof PROJECT_ROLES] || m.projectRole}
                  </Badge>
                )}
              </TableCell>
              <TableCell>{new Date(m.createdAt).toLocaleDateString('ja-JP')}</TableCell>
              {isAdmin && (
                <TableCell>
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-red-600"
                    onClick={() => handleRemove(m.id, m.userName)}
                  >
                    解除
                  </Button>
                </TableCell>
              )}
            </TableRow>
          ))}
          {members.length === 0 && (
            <TableRow>
              <TableCell colSpan={isAdmin ? 5 : 4} className="py-8 text-center text-gray-500">
                メンバーが登録されていません
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
