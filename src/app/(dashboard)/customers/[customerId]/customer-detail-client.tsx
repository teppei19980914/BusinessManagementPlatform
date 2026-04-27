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
import { useTranslations } from 'next-intl';
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
  const t = useTranslations('customer');
  const tAction = useTranslations('action');
  const tProject = useTranslations('project');
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
      setEditError(json.error?.message || t('editFailed'));
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
      window.alert(json.error?.message || t('deleteFailed'));
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
              {t('listTitle')}
            </Link>
            {' / '}{t('detailBreadcrumb')}
          </p>
          <h2 className="mt-1 text-2xl font-semibold">{customer.name}</h2>
        </div>
        <div className="flex items-center gap-2">
          <Dialog open={isEditOpen} onOpenChange={(o) => (o ? openEdit() : setIsEditOpen(false))}>
            <DialogTrigger className="inline-flex shrink-0 items-center justify-center rounded-md border border-input bg-background px-3 py-1.5 text-sm hover:bg-accent">
              {tAction('edit')}
            </DialogTrigger>
            <DialogContent className="max-w-[min(90vw,42rem)] max-h-[80vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>{t('editDialogTitle')}</DialogTitle>
                <DialogDescription>{t('editDialogDescription')}</DialogDescription>
              </DialogHeader>
              <form onSubmit={handleEdit} className="space-y-4">
                {editError && (
                  <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                    {editError}
                  </div>
                )}
                <div className="space-y-2">
                  <Label htmlFor="edit-name">{t('fieldNameRequired')}</Label>
                  <Input
                    id="edit-name"
                    value={editForm.name}
                    onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                    required
                    maxLength={100}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="edit-department">{t('fieldDepartment')}</Label>
                  <Input
                    id="edit-department"
                    value={editForm.department}
                    onChange={(e) => setEditForm({ ...editForm, department: e.target.value })}
                    maxLength={100}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="edit-contact-person">{t('fieldContactPerson')}</Label>
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
                  <Label htmlFor="edit-contact-email">{t('fieldContactEmail')}</Label>
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
                  <Label htmlFor="edit-notes">{t('fieldNotes')}</Label>
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
                    {tAction('cancel')}
                  </Button>
                  <Button type="submit">{t('editSubmit')}</Button>
                </div>
              </form>
            </DialogContent>
          </Dialog>
          <Dialog open={isDeleteOpen} onOpenChange={setIsDeleteOpen}>
            <DialogTrigger
              className="inline-flex shrink-0 items-center justify-center rounded-md bg-destructive px-3 py-1.5 text-sm font-medium text-destructive-foreground hover:bg-destructive/90"
              onClick={openDelete}
            >
              {tAction('delete')}
            </DialogTrigger>
            <DialogContent className="max-w-[min(90vw,42rem)] max-h-[80vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>{t('deleteDialogTitle')}</DialogTitle>
                <DialogDescription>
                  {t('deleteDialogDescription', { name: customer.name })}
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4">
                {customer.activeProjectCount > 0 ? (
                  <>
                    <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm">
                      {t('deleteCascadeWarningPrefix')}
                      <strong className="mx-1">{customer.activeProjectCount}</strong>
                      {t('deleteCascadeWarningSuffix')}
                      <strong>{t('deleteCascadeWarningEmphasis')}</strong>{t('deleteCascadeWarningTail')}
                    </div>
                    <div className="space-y-2 rounded-md border p-3">
                      <label className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={cascadeRisks}
                          onChange={(e) => setCascadeRisks(e.target.checked)}
                        />
                        {t('deleteCascadeRisks')}
                      </label>
                      <label className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={cascadeIssues}
                          onChange={(e) => setCascadeIssues(e.target.checked)}
                        />
                        {t('deleteCascadeIssues')}
                      </label>
                      <label className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={cascadeRetros}
                          onChange={(e) => setCascadeRetros(e.target.checked)}
                        />
                        {t('deleteCascadeRetros')}
                      </label>
                      <label className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={cascadeKnowledge}
                          onChange={(e) => setCascadeKnowledge(e.target.checked)}
                        />
                        {t('deleteCascadeKnowledge')}
                      </label>
                    </div>
                  </>
                ) : (
                  <div className="rounded-md border bg-muted/30 p-3 text-sm">
                    {t('deleteNoCascadeMessage')}
                  </div>
                )}
                <div className="flex justify-end gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setIsDeleteOpen(false)}
                  >
                    {tAction('cancel')}
                  </Button>
                  <Button
                    type="button"
                    variant="destructive"
                    onClick={handleConfirmDelete}
                  >
                    {t('deleteSubmit')}
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
            <dt className="text-xs font-medium text-muted-foreground">{t('fieldDepartment')}</dt>
            <dd className="mt-1 text-sm">{customer.department || '—'}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-muted-foreground">{t('fieldContactPerson')}</dt>
            <dd className="mt-1 text-sm">{customer.contactPerson || '—'}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-muted-foreground">{t('fieldContactEmail')}</dt>
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
            <dt className="text-xs font-medium text-muted-foreground">{t('infoActiveProjectCount')}</dt>
            <dd className="mt-1 text-sm">
              {customer.activeProjectCount > 0 ? (
                <Badge variant="secondary">{t('projectCount', { count: customer.activeProjectCount })}</Badge>
              ) : (
                t('projectCount', { count: 0 })
              )}
            </dd>
          </div>
          <div className="sm:col-span-2">
            <dt className="text-xs font-medium text-muted-foreground">{t('fieldNotes')}</dt>
            <dd className="mt-1 whitespace-pre-wrap text-sm">{customer.notes || '—'}</dd>
          </div>
        </dl>
      </div>

      {/* 紐付プロジェクト一覧 */}
      <div>
        <h3 className="mb-2 text-lg font-semibold">{t('relatedProjectsHeading')}</h3>
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{tProject('fieldName')}</TableHead>
                <TableHead>{tProject('fieldStatus')}</TableHead>
                <TableHead>{tProject('fieldPlannedStartDate')}</TableHead>
                <TableHead>{tProject('fieldPlannedEndDate')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {projects.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="text-center text-muted-foreground">
                    {t('relatedProjectsEmpty')}
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
