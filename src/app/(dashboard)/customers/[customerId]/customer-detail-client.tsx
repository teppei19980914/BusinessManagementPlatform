'use client';

/**
 * 顧客詳細画面 (PR #111-2)。
 *
 * 役割:
 *   - 顧客の全項目表示 (name / department / contactPerson / contactEmail / notes)
 *   - 紐付く active Project 一覧表示 (カスケード削除時に影響するスコープを可視化)
 *   - インライン編集ダイアログ (PATCH /api/customers/[id])
 *   - カスケード削除ダイアログ (DELETE /api/customers/[id]?cascade=...)
 *     - active Project 0 件 → 単純削除
 *     - active Project 1+ 件 → 4 オプション (Risks / Issues / Retros / Knowledge) 付き
 *
 * 認可: 親 page.tsx で admin を確認済の前提。
 */

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useLoading } from '@/components/loading-overlay';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { PROJECT_STATUSES } from '@/types';
import type { CustomerDTO } from '@/services/customer.service';

type ProjectSummary = {
  id: string;
  name: string;
  status: string;
  plannedStartDate: string;
  plannedEndDate: string;
};

type Props = {
  customer: CustomerDTO;
  projects: ProjectSummary[];
};

export function CustomerDetailClient({ customer, projects }: Props) {
  const router = useRouter();
  const { withLoading } = useLoading();

  // --- 編集ダイアログ ---
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [editForm, setEditForm] = useState({
    name: customer.name,
    department: customer.department ?? '',
    contactPerson: customer.contactPerson ?? '',
    contactEmail: customer.contactEmail ?? '',
    notes: customer.notes ?? '',
  });
  const [editError, setEditError] = useState('');

  function openEdit() {
    setEditForm({
      name: customer.name,
      department: customer.department ?? '',
      contactPerson: customer.contactPerson ?? '',
      contactEmail: customer.contactEmail ?? '',
      notes: customer.notes ?? '',
    });
    setEditError('');
    setIsEditOpen(true);
  }

  async function handleEdit(e: React.FormEvent) {
    e.preventDefault();
    setEditError('');
    const res = await withLoading(() =>
      fetch(`/api/customers/${customer.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: editForm.name,
          department: editForm.department || null,
          contactPerson: editForm.contactPerson || null,
          contactEmail: editForm.contactEmail || null,
          notes: editForm.notes || null,
        }),
      }),
    );
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      setEditError(json.error?.message || '更新に失敗しました');
      return;
    }
    setIsEditOpen(false);
    router.refresh();
  }

  // --- 削除ダイアログ (カスケード対応) ---
  const [isDeleteOpen, setIsDeleteOpen] = useState(false);
  const [cascadeRisks, setCascadeRisks] = useState(false);
  const [cascadeIssues, setCascadeIssues] = useState(false);
  const [cascadeRetros, setCascadeRetros] = useState(false);
  const [cascadeKnowledge, setCascadeKnowledge] = useState(false);

  function openDelete() {
    setCascadeRisks(false);
    setCascadeIssues(false);
    setCascadeRetros(false);
    setCascadeKnowledge(false);
    setIsDeleteOpen(true);
  }

  async function handleConfirmDelete() {
    setIsDeleteOpen(false);
    const params = new URLSearchParams();
    if (customer.activeProjectCount > 0) {
      params.set('cascade', 'true');
      params.set('cascadeRisks', String(cascadeRisks));
      params.set('cascadeIssues', String(cascadeIssues));
      params.set('cascadeRetros', String(cascadeRetros));
      params.set('cascadeKnowledge', String(cascadeKnowledge));
    }
    const res = await withLoading(() =>
      fetch(`/api/customers/${customer.id}?${params.toString()}`, { method: 'DELETE' }),
    );
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      window.alert(json.error?.message || '削除に失敗しました');
      return;
    }
    router.push('/customers');
  }

  return (
    <div className="space-y-6">
      {/* ヘッダー */}
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm text-muted-foreground">
            <Link href="/customers" className="hover:underline">
              顧客管理
            </Link>
            {' / '}顧客詳細
          </p>
          <h2 className="mt-1 text-2xl font-semibold">{customer.name}</h2>
        </div>
        <div className="flex items-center gap-2">
          <Dialog open={isEditOpen} onOpenChange={(o) => (o ? openEdit() : setIsEditOpen(false))}>
            <DialogTrigger className="inline-flex shrink-0 items-center justify-center rounded-md border border-input bg-background px-3 py-1.5 text-sm hover:bg-accent">
              編集
            </DialogTrigger>
            <DialogContent className="max-w-[min(90vw,42rem)] max-h-[80vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>顧客情報編集</DialogTitle>
                <DialogDescription>顧客情報を更新します。</DialogDescription>
              </DialogHeader>
              <form onSubmit={handleEdit} className="space-y-4">
                {editError && (
                  <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                    {editError}
                  </div>
                )}
                <div className="space-y-2">
                  <Label htmlFor="edit-name">顧客名 *</Label>
                  <Input
                    id="edit-name"
                    value={editForm.name}
                    onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                    required
                    maxLength={100}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="edit-department">部門</Label>
                  <Input
                    id="edit-department"
                    value={editForm.department}
                    onChange={(e) => setEditForm({ ...editForm, department: e.target.value })}
                    maxLength={100}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="edit-contact-person">担当者</Label>
                  <Input
                    id="edit-contact-person"
                    value={editForm.contactPerson}
                    onChange={(e) =>
                      setEditForm({ ...editForm, contactPerson: e.target.value })
                    }
                    maxLength={100}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="edit-contact-email">担当者メール</Label>
                  <Input
                    id="edit-contact-email"
                    type="email"
                    value={editForm.contactEmail}
                    onChange={(e) =>
                      setEditForm({ ...editForm, contactEmail: e.target.value })
                    }
                    maxLength={255}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="edit-notes">備考</Label>
                  <textarea
                    id="edit-notes"
                    className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                    value={editForm.notes}
                    onChange={(e) => setEditForm({ ...editForm, notes: e.target.value })}
                    maxLength={1000}
                    rows={3}
                  />
                </div>
                <div className="flex justify-end gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setIsEditOpen(false)}
                  >
                    キャンセル
                  </Button>
                  <Button type="submit">更新</Button>
                </div>
              </form>
            </DialogContent>
          </Dialog>
          <Dialog open={isDeleteOpen} onOpenChange={setIsDeleteOpen}>
            <DialogTrigger
              className="inline-flex shrink-0 items-center justify-center rounded-md bg-destructive px-3 py-1.5 text-sm font-medium text-destructive-foreground hover:bg-destructive/90"
              onClick={openDelete}
            >
              削除
            </DialogTrigger>
            <DialogContent className="max-w-[min(90vw,42rem)] max-h-[80vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>顧客削除</DialogTitle>
                <DialogDescription>
                  顧客「{customer.name}」を物理削除します。この操作は取り消せません。
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4">
                {customer.activeProjectCount > 0 ? (
                  <>
                    <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm">
                      この顧客には active なプロジェクトが
                      <strong className="mx-1">{customer.activeProjectCount}</strong>
                      件紐付いています。削除を実行すると、紐付くプロジェクト本体・WBS・見積・メンバー・添付は
                      <strong>常に</strong>物理削除されます。以下は任意で選択してください。
                    </div>
                    <div className="space-y-2 rounded-md border p-3">
                      <label className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={cascadeRisks}
                          onChange={(e) => setCascadeRisks(e.target.checked)}
                        />
                        リスクも削除する
                      </label>
                      <label className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={cascadeIssues}
                          onChange={(e) => setCascadeIssues(e.target.checked)}
                        />
                        課題も削除する
                      </label>
                      <label className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={cascadeRetros}
                          onChange={(e) => setCascadeRetros(e.target.checked)}
                        />
                        振り返り (コメント含む) も削除する
                      </label>
                      <label className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={cascadeKnowledge}
                          onChange={(e) => setCascadeKnowledge(e.target.checked)}
                        />
                        ナレッジも削除する (他プロジェクト共有分は紐付け解除のみ)
                      </label>
                    </div>
                  </>
                ) : (
                  <div className="rounded-md border bg-muted/30 p-3 text-sm">
                    紐付く active プロジェクトはありません。顧客情報のみ削除されます。
                  </div>
                )}
                <div className="flex justify-end gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setIsDeleteOpen(false)}
                  >
                    キャンセル
                  </Button>
                  <Button
                    type="button"
                    variant="destructive"
                    onClick={handleConfirmDelete}
                  >
                    削除する
                  </Button>
                </div>
              </div>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {/* 顧客情報 */}
      <div className="rounded-md border p-4">
        <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <dt className="text-xs font-medium text-muted-foreground">部門</dt>
            <dd className="mt-1 text-sm">{customer.department || '—'}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-muted-foreground">担当者</dt>
            <dd className="mt-1 text-sm">{customer.contactPerson || '—'}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-muted-foreground">担当者メール</dt>
            <dd className="mt-1 text-sm">
              {customer.contactEmail ? (
                <a
                  href={`mailto:${customer.contactEmail}`}
                  className="text-info hover:underline"
                >
                  {customer.contactEmail}
                </a>
              ) : (
                '—'
              )}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-muted-foreground">紐付 active プロジェクト</dt>
            <dd className="mt-1 text-sm">
              {customer.activeProjectCount > 0 ? (
                <Badge variant="secondary">{customer.activeProjectCount} 件</Badge>
              ) : (
                '0 件'
              )}
            </dd>
          </div>
          <div className="sm:col-span-2">
            <dt className="text-xs font-medium text-muted-foreground">備考</dt>
            <dd className="mt-1 whitespace-pre-wrap text-sm">{customer.notes || '—'}</dd>
          </div>
        </dl>
      </div>

      {/* 紐付プロジェクト一覧 */}
      <div>
        <h3 className="mb-2 text-lg font-semibold">紐付プロジェクト</h3>
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>プロジェクト名</TableHead>
                <TableHead>ステータス</TableHead>
                <TableHead>開始予定日</TableHead>
                <TableHead>終了予定日</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {projects.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="text-center text-muted-foreground">
                    この顧客に紐付く active なプロジェクトはありません
                  </TableCell>
                </TableRow>
              )}
              {projects.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="font-medium">
                    <Link
                      href={`/projects/${p.id}`}
                      className="text-info hover:underline"
                    >
                      {p.name}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary">
                      {PROJECT_STATUSES[p.status as keyof typeof PROJECT_STATUSES] || p.status}
                    </Badge>
                  </TableCell>
                  <TableCell>{p.plannedStartDate}</TableCell>
                  <TableCell>{p.plannedEndDate}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  );
}
