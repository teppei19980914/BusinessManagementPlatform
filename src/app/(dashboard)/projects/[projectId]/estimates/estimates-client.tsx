'use client';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useLoading } from '@/components/loading-overlay';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { NumberInput } from '@/components/ui/number-input';
import { Label } from '@/components/ui/label';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';
import { nativeSelectClass } from '@/components/ui/native-select-style';
import { TASK_CATEGORIES, DEV_METHODS, EFFORT_UNITS } from '@/types';
import type { EstimateDTO } from '@/services/estimate.service';

type Props = {
  projectId: string;
  estimates: EstimateDTO[];
  canEdit: boolean;
  /** CRUD 後に呼び出す再取得ハンドラ（未指定時は router.refresh フォールバック）*/
  onReload?: () => Promise<void> | void;
};

export function EstimatesClient({ projectId, estimates, canEdit, onReload }: Props) {
  const router = useRouter();
  const { withLoading } = useLoading();

  const reload = useCallback(async () => {
    if (onReload) {
      await onReload();
    } else {
      router.refresh();
    }
  }, [onReload, router]);
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
    const res = await withLoading(() =>
      fetch(`/api/projects/${projectId}/estimates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      }),
    );
    if (!res.ok) {
      const json = await res.json();
      setError(json.error?.message || json.error?.details?.[0]?.message || '作成に失敗しました');
      return;
    }
    setIsCreateOpen(false);
    setForm({ itemName: '', category: 'development', devMethod: 'scratch', estimatedEffort: 0, effortUnit: 'person_hour', rationale: '' });
    await reload();
  }

  async function handleConfirm(estimateId: string) {
    await withLoading(() =>
      fetch(`/api/projects/${projectId}/estimates/${estimateId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'confirm' }),
      }),
    );
    await reload();
  }

  const totalEffort = estimates.reduce((sum, e) => sum + e.estimatedEffort, 0);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold">見積もり管理</h2>
          <p className="text-sm text-muted-foreground">合計工数: {totalEffort}</p>
        </div>
        {canEdit && (
          <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
            <DialogTrigger className="inline-flex shrink-0 items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-xs hover:bg-primary/90">見積もり追加</DialogTrigger>
            <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>見積もり項目追加</DialogTitle>
                <DialogDescription>見積もり情報を入力してください。</DialogDescription>
              </DialogHeader>
              <form onSubmit={handleCreate} className="space-y-4">
                {error && <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}
                <div className="space-y-2">
                  <Label>見積項目名</Label>
                  <Input value={form.itemName} onChange={(e) => setForm({ ...form, itemName: e.target.value })} maxLength={100} required />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>区分</Label>
                    <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} className={nativeSelectClass}>
                      {Object.entries(TASK_CATEGORIES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                    </select>
                  </div>
                  <div className="space-y-2">
                    <Label>開発方式</Label>
                    <select value={form.devMethod} onChange={(e) => setForm({ ...form, devMethod: e.target.value })} className={nativeSelectClass}>
                      {Object.entries(DEV_METHODS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                    </select>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>見積工数</Label>
                    <NumberInput min={1} step={0.5} value={form.estimatedEffort} onChange={(n) => setForm({ ...form, estimatedEffort: n })} required />
                  </div>
                  <div className="space-y-2">
                    <Label>単位</Label>
                    <select value={form.effortUnit} onChange={(e) => setForm({ ...form, effortUnit: e.target.value })} className={nativeSelectClass}>
                      {Object.entries(EFFORT_UNITS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                    </select>
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
                  <div className="flex gap-1">
                    {!e.isConfirmed && (
                      <Button variant="outline" size="sm" onClick={() => handleConfirm(e.id)}>確定</Button>
                    )}
                    {!e.isConfirmed && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="text-destructive"
                        onClick={async () => {
                          if (!confirm('この見積もりを削除しますか？')) return;
                          await withLoading(() =>
                            fetch(`/api/projects/${projectId}/estimates/${e.id}`, { method: 'DELETE' }),
                          );
                          await reload();
                        }}
                      >
                        削除
                      </Button>
                    )}
                  </div>
                </TableCell>
              )}
            </TableRow>
          ))}
          {estimates.length === 0 && (
            <TableRow>
              <TableCell colSpan={canEdit ? 6 : 5} className="py-8 text-center text-muted-foreground">見積もり項目がありません</TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
