'use client';

/**
 * 顧客管理 クライアント (PR #111-1)。
 *
 * 役割:
 *   - 全顧客の一覧表示 (紐付く active Project 件数付き)
 *   - 新規顧客作成ダイアログ
 *   - 削除ボタン (active Project が 0 件の顧客のみ削除可能)
 *
 * PR #111-2 で追加:
 *   - 顧客名クリックで詳細画面 (/customers/[id]) に遷移
 *   - 詳細画面側で編集 + カスケード削除 (active Project があっても cascade オプションで一括削除) 対応
 *
 * 認可: ページ側 (page.tsx) で systemRole='admin' を確認済の前提。
 */

import { useState } from 'react';
import Link from 'next/link';
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
import type { CustomerDTO } from '@/services/customer.service';

type Props = {
  initialCustomers: CustomerDTO[];
};

type FormState = {
  name: string;
  department: string;
  contactPerson: string;
  contactEmail: string;
  notes: string;
};

const emptyForm: FormState = {
  name: '',
  department: '',
  contactPerson: '',
  contactEmail: '',
  notes: '',
};

export function CustomersClient({ initialCustomers }: Props) {
  const router = useRouter();
  const { withLoading } = useLoading();
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [error, setError] = useState('');

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError('');

    const res = await withLoading(() =>
      fetch('/api/customers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: form.name,
          department: form.department || null,
          contactPerson: form.contactPerson || null,
          contactEmail: form.contactEmail || null,
          notes: form.notes || null,
        }),
      }),
    );
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      setError(json.error?.message || '顧客の作成に失敗しました');
      return;
    }

    setIsDialogOpen(false);
    setForm(emptyForm);
    router.refresh();
  }

  async function handleDelete(customer: CustomerDTO) {
    // PR #111-2: active Project 紐付きありの場合は詳細画面のカスケード削除ダイアログへ誘導
    if (customer.activeProjectCount > 0) {
      router.push(`/customers/${customer.id}`);
      return;
    }
    if (!window.confirm(`顧客「${customer.name}」を削除します。よろしいですか？`)) return;

    const res = await withLoading(() =>
      fetch(`/api/customers/${customer.id}`, { method: 'DELETE' }),
    );
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      window.alert(json.error?.message || '顧客の削除に失敗しました');
      return;
    }
    router.refresh();
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">顧客管理</h2>
        <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
          <DialogTrigger className="inline-flex shrink-0 items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-xs hover:bg-primary/90">
            新規顧客登録
          </DialogTrigger>
          {/* PR #112: admin ダイアログの大画面余白対策 (基底で scroll 対応済) */}
          <DialogContent className="max-w-[min(90vw,32rem)] lg:max-w-[min(70vw,44rem)]">
            <DialogHeader>
              <DialogTitle>新規顧客登録</DialogTitle>
              <DialogDescription>
                顧客情報を入力してください。顧客名のみ必須です。
              </DialogDescription>
            </DialogHeader>

            {error && (
              <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                {error}
              </div>
            )}

            <form onSubmit={handleCreate} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="customer-name">顧客名 *</Label>
                <Input
                  id="customer-name"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  required
                  maxLength={100}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="customer-department">部門</Label>
                <Input
                  id="customer-department"
                  value={form.department}
                  onChange={(e) => setForm({ ...form, department: e.target.value })}
                  maxLength={100}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="customer-contact-person">担当者</Label>
                <Input
                  id="customer-contact-person"
                  value={form.contactPerson}
                  onChange={(e) => setForm({ ...form, contactPerson: e.target.value })}
                  maxLength={100}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="customer-contact-email">担当者メール</Label>
                <Input
                  id="customer-contact-email"
                  type="email"
                  value={form.contactEmail}
                  onChange={(e) => setForm({ ...form, contactEmail: e.target.value })}
                  maxLength={255}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="customer-notes">備考</Label>
                <textarea
                  id="customer-notes"
                  className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  value={form.notes}
                  onChange={(e) => setForm({ ...form, notes: e.target.value })}
                  maxLength={1000}
                  rows={3}
                />
              </div>
              <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" onClick={() => setIsDialogOpen(false)}>
                  キャンセル
                </Button>
                <Button type="submit">登録</Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>顧客名</TableHead>
              <TableHead>部門</TableHead>
              <TableHead>担当者</TableHead>
              <TableHead>メール</TableHead>
              <TableHead>紐付プロジェクト</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {initialCustomers.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-muted-foreground">
                  顧客が登録されていません
                </TableCell>
              </TableRow>
            )}
            {initialCustomers.map((customer) => (
              <TableRow key={customer.id}>
                <TableCell className="font-medium">
                  <Link
                    href={`/customers/${customer.id}`}
                    className="text-info hover:underline"
                  >
                    {customer.name}
                  </Link>
                </TableCell>
                <TableCell>{customer.department || '—'}</TableCell>
                <TableCell>{customer.contactPerson || '—'}</TableCell>
                <TableCell>{customer.contactEmail || '—'}</TableCell>
                <TableCell>
                  {customer.activeProjectCount > 0 ? (
                    <Badge variant="secondary">{customer.activeProjectCount} 件</Badge>
                  ) : (
                    <span className="text-muted-foreground">0 件</span>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => handleDelete(customer)}
                    title={
                      customer.activeProjectCount > 0
                        ? '紐付くプロジェクトがあります — 詳細画面のカスケード削除をご利用ください'
                        : undefined
                    }
                  >
                    削除
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
