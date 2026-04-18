'use client';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useLoading } from '@/components/loading-overlay';
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
import { LabeledSelect } from '@/components/labeled-select';
import { nativeSelectClass } from '@/components/ui/native-select-style';
import { RiskEditDialog } from '@/components/dialogs/risk-edit-dialog';
import { PRIORITIES, RISK_ISSUE_STATES } from '@/types';
import type { RiskDTO } from '@/services/risk.service';
import type { MemberDTO } from '@/services/member.service';

type Props = {
  projectId: string;
  risks: RiskDTO[];
  members: MemberDTO[];
  canEdit: boolean;
  canCreate: boolean;
  systemRole: string;
  /** CRUD 後に呼び出す再取得ハンドラ（未指定時は router.refresh フォールバック）*/
  onReload?: () => Promise<void> | void;
};

const impactColors: Record<string, 'default' | 'secondary' | 'destructive'> = {
  high: 'destructive',
  medium: 'default',
  low: 'secondary',
};

export function RisksClient({ projectId, risks, members, canCreate, systemRole, onReload }: Props) {
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
  // 行クリックで開く編集ダイアログの対象 (null = 閉じる)
  const [editingRisk, setEditingRisk] = useState<RiskDTO | null>(null);
  const [form, setForm] = useState({
    type: 'risk',
    title: '',
    content: '',
    impact: 'medium',
    likelihood: 'medium',
    priority: 'medium',
    assigneeId: '',
  });

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    const body = { ...form, assigneeId: form.assigneeId || undefined, likelihood: form.type === 'risk' ? form.likelihood : undefined };
    const res = await withLoading(() =>
      fetch(`/api/projects/${projectId}/risks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
    if (!res.ok) {
      const json = await res.json();
      setError(json.error?.message || json.error?.details?.[0]?.message || '作成に失敗しました');
      return;
    }
    setIsCreateOpen(false);
    setForm({ type: 'risk', title: '', content: '', impact: 'medium', likelihood: 'medium', priority: 'medium', assigneeId: '' });
    await reload();
  }

  async function handleExport() {
    window.open(`/api/projects/${projectId}/risks/export`, '_blank');
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">リスク / 課題管理</h2>
        <div className="flex gap-2">
          {systemRole === 'admin' && (
            <Button variant="outline" onClick={handleExport}>CSV出力</Button>
          )}
          {canCreate && (
            <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
              <DialogTrigger className="inline-flex shrink-0 items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-xs hover:bg-primary/90">起票</DialogTrigger>
              <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
                <DialogHeader>
                  <DialogTitle>リスク / 課題 起票</DialogTitle>
                  <DialogDescription>リスクまたは課題を登録してください。</DialogDescription>
                </DialogHeader>
                <form onSubmit={handleCreate} className="space-y-4">
                  {error && <div className="rounded-md bg-red-50 p-3 text-sm text-red-600">{error}</div>}
                  <div className="space-y-2">
                    <Label>種別</Label>
                    <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })} className={nativeSelectClass}>
                      <option value="risk">リスク</option>
                      <option value="issue">課題</option>
                    </select>
                  </div>
                  <div className="space-y-2">
                    <Label>件名</Label>
                    <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} maxLength={100} required />
                  </div>
                  <div className="space-y-2">
                    <Label>内容</Label>
                    <textarea className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={form.content} onChange={(e) => setForm({ ...form, content: e.target.value })} rows={4} maxLength={2000} required />
                  </div>
                  <div className="grid grid-cols-3 gap-4">
                    <div className="space-y-2">
                      <Label>影響度</Label>
                      <select value={form.impact} onChange={(e) => setForm({ ...form, impact: e.target.value })} className={nativeSelectClass}>
                        {Object.entries(PRIORITIES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                      </select>
                    </div>
                    {form.type === 'risk' && (
                      <div className="space-y-2">
                        <Label>発生可能性</Label>
                        <select value={form.likelihood} onChange={(e) => setForm({ ...form, likelihood: e.target.value })} className={nativeSelectClass}>
                          {Object.entries(PRIORITIES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                        </select>
                      </div>
                    )}
                    <div className="space-y-2">
                      <Label>優先度</Label>
                      <select value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })} className={nativeSelectClass}>
                        {Object.entries(PRIORITIES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                      </select>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label>担当者</Label>
                    <select value={form.assigneeId} onChange={(e) => setForm({ ...form, assigneeId: e.target.value })} className={nativeSelectClass}>
                      <option value="">未設定</option>
                      {members.map((m) => <option key={m.userId} value={m.userId}>{m.userName}</option>)}
                    </select>
                  </div>
                  <Button type="submit" className="w-full">起票</Button>
                </form>
              </DialogContent>
            </Dialog>
          )}
        </div>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>種別</TableHead>
            <TableHead>件名</TableHead>
            <TableHead>影響度</TableHead>
            <TableHead>優先度</TableHead>
            <TableHead>状態</TableHead>
            <TableHead>担当者</TableHead>
            <TableHead>起票日</TableHead>
            {canCreate && <TableHead>操作</TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {risks.map((r) => (
            <TableRow
              key={r.id}
              // Req 8: 行クリックで編集ダイアログを開く (canCreate = メンバー以上)
              className={canCreate ? 'cursor-pointer hover:bg-gray-50' : ''}
              onClick={canCreate ? () => setEditingRisk(r) : undefined}
            >
              <TableCell><Badge variant="outline">{r.type === 'risk' ? 'リスク' : '課題'}</Badge></TableCell>
              <TableCell className="font-medium">{r.title}</TableCell>
              <TableCell><Badge variant={impactColors[r.impact] || 'secondary'}>{PRIORITIES[r.impact as keyof typeof PRIORITIES]}</Badge></TableCell>
              <TableCell><Badge variant={impactColors[r.priority] || 'secondary'}>{PRIORITIES[r.priority as keyof typeof PRIORITIES]}</Badge></TableCell>
              <TableCell onClick={(e) => e.stopPropagation()}>
                {/* 状態変更の Select は行クリックの伝播を止めて単独動作させる */}
                <LabeledSelect
                  value={r.state}
                  onValueChange={async (v) => {
                    if (!v || v === r.state) return;
                    await withLoading(() =>
                      fetch(`/api/projects/${projectId}/risks/${r.id}`, {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ state: v }),
                      }),
                    );
                    await reload();
                  }}
                  options={RISK_ISSUE_STATES}
                  className="w-24"
                />
              </TableCell>
              <TableCell>{r.assigneeName || '-'}</TableCell>
              <TableCell>{new Date(r.createdAt).toLocaleDateString('ja-JP')}</TableCell>
              {canCreate && (
                <TableCell onClick={(e) => e.stopPropagation()}>
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-red-600"
                    onClick={async () => {
                      if (!confirm('このリスク/課題を削除しますか？')) return;
                      await withLoading(() =>
                        fetch(`/api/projects/${projectId}/risks/${r.id}`, { method: 'DELETE' }),
                      );
                      await reload();
                    }}
                  >
                    削除
                  </Button>
                </TableCell>
              )}
            </TableRow>
          ))}
          {risks.length === 0 && (
            <TableRow><TableCell colSpan={canCreate ? 8 : 7} className="py-8 text-center text-gray-500">リスク / 課題がありません</TableCell></TableRow>
          )}
        </TableBody>
      </Table>

      <RiskEditDialog
        risk={editingRisk}
        members={members}
        open={editingRisk != null}
        onOpenChange={(v) => { if (!v) setEditingRisk(null); }}
        onSaved={reload}
      />
    </div>
  );
}
