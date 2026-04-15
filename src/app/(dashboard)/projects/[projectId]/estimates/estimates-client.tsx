'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { TASK_CATEGORIES, DEV_METHODS, EFFORT_UNITS } from '@/types';
import type { EstimateDTO } from '@/services/estimate.service';

type Props = {
  projectId: string;
  estimates: EstimateDTO[];
  canEdit: boolean;
};

export function EstimatesClient({ projectId, estimates, canEdit }: Props) {
  const router = useRouter();
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [error, setError] = useState('');
  const [form, setForm] = useState({
    itemName: '',
    category: 'development',
    devMethod: 'scratch',
    estimatedEffort: 0,
    effortUnit: 'person_hour',
    rationale: '',
  });

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    const res = await fetch(`/api/projects/${projectId}/estimates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(form),
    });
    if (!res.ok) {
      const json = await res.json();
      setError(json.error?.message || json.error?.details?.[0]?.message || '作成に失敗しました');
      return;
    }
    setIsCreateOpen(false);
    setForm({ itemName: '', category: 'development', devMethod: 'scratch', estimatedEffort: 0, effortUnit: 'person_hour', rationale: '' });
    router.refresh();
  }

  async function handleConfirm(estimateId: string) {
    await fetch(`/api/projects/${projectId}/estimates/${estimateId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'confirm' }),
    });
    router.refresh();
  }

  const totalEffort = estimates.reduce((sum, e) => sum + e.estimatedEffort, 0);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold">見積もり管理</h2>
          <p className="text-sm text-gray-500">合計工数: {totalEffort}</p>
        </div>
        {canEdit && (
          <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
            <DialogTrigger><Button>見積もり追加</Button></DialogTrigger>
            <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>見積もり項目追加</DialogTitle>
                <DialogDescription>見積もり情報を入力してください。</DialogDescription>
              </DialogHeader>
              <form onSubmit={handleCreate} className="space-y-4">
                {error && <div className="rounded-md bg-red-50 p-3 text-sm text-red-600">{error}</div>}
                <div className="space-y-2">
                  <Label>見積項目名</Label>
                  <Input value={form.itemName} onChange={(e) => setForm({ ...form, itemName: e.target.value })} maxLength={100} required />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>区分</Label>
                    <Select value={form.category} onValueChange={(v) => v && setForm({ ...form, category: v })}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {Object.entries(TASK_CATEGORIES).map(([k, l]) => <SelectItem key={k} value={k}>{l}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>開発方式</Label>
                    <Select value={form.devMethod} onValueChange={(v) => v && setForm({ ...form, devMethod: v })}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {Object.entries(DEV_METHODS).map(([k, l]) => <SelectItem key={k} value={k}>{l}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>見積工数</Label>
                    <Input type="number" min={0} step={0.5} value={form.estimatedEffort} onChange={(e) => setForm({ ...form, estimatedEffort: Number(e.target.value) })} required />
                  </div>
                  <div className="space-y-2">
                    <Label>単位</Label>
                    <Select value={form.effortUnit} onValueChange={(v) => v && setForm({ ...form, effortUnit: v })}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {Object.entries(EFFORT_UNITS).map(([k, l]) => <SelectItem key={k} value={k}>{l}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="space-y-2">
                  <Label>見積根拠</Label>
                  <textarea className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={form.rationale} onChange={(e) => setForm({ ...form, rationale: e.target.value })} rows={4} maxLength={3000} required />
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
            <TableHead>項目名</TableHead>
            <TableHead>区分</TableHead>
            <TableHead>工数</TableHead>
            <TableHead>根拠（要約）</TableHead>
            <TableHead>状態</TableHead>
            {canEdit && <TableHead>操作</TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {estimates.map((e) => (
            <TableRow key={e.id}>
              <TableCell className="font-medium">{e.itemName}</TableCell>
              <TableCell>{TASK_CATEGORIES[e.category as keyof typeof TASK_CATEGORIES] || e.category}</TableCell>
              <TableCell>{e.estimatedEffort} {EFFORT_UNITS[e.effortUnit as keyof typeof EFFORT_UNITS] || e.effortUnit}</TableCell>
              <TableCell className="max-w-xs truncate">{e.rationale}</TableCell>
              <TableCell>
                <Badge variant={e.isConfirmed ? 'default' : 'outline'}>
                  {e.isConfirmed ? '確定' : '未確定'}
                </Badge>
              </TableCell>
              {canEdit && (
                <TableCell>
                  {!e.isConfirmed && (
                    <Button variant="outline" size="sm" onClick={() => handleConfirm(e.id)}>確定</Button>
                  )}
                </TableCell>
              )}
            </TableRow>
          ))}
          {estimates.length === 0 && (
            <TableRow>
              <TableCell colSpan={canEdit ? 6 : 5} className="py-8 text-center text-gray-500">見積もり項目がありません</TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
