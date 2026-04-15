'use client';

import { useState } from 'react';
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
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { LabeledSelect } from '@/components/labeled-select';
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
};

const stateColors: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  open: 'destructive',
  in_progress: 'default',
  monitoring: 'secondary',
  resolved: 'outline',
};

const impactColors: Record<string, 'default' | 'secondary' | 'destructive'> = {
  high: 'destructive',
  medium: 'default',
  low: 'secondary',
};

export function RisksClient({ projectId, risks, members, canCreate, systemRole }: Props) {
  const router = useRouter();
  const { withLoading } = useLoading();
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [error, setError] = useState('');
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
    router.refresh();
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
              <DialogTrigger><Button>起票</Button></DialogTrigger>
              <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
                <DialogHeader>
                  <DialogTitle>リスク / 課題 起票</DialogTitle>
                  <DialogDescription>リスクまたは課題を登録してください。</DialogDescription>
                </DialogHeader>
                <form onSubmit={handleCreate} className="space-y-4">
                  {error && <div className="rounded-md bg-red-50 p-3 text-sm text-red-600">{error}</div>}
                  <div className="space-y-2">
                    <Label>種別</Label>
                    <Select value={form.type} onValueChange={(v) => v && setForm({ ...form, type: v })}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="risk">リスク</SelectItem>
                        <SelectItem value="issue">課題</SelectItem>
                      </SelectContent>
                    </Select>
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
                      <Select value={form.impact} onValueChange={(v) => v && setForm({ ...form, impact: v })}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {Object.entries(PRIORITIES).map(([k, l]) => <SelectItem key={k} value={k}>{l}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>
                    {form.type === 'risk' && (
                      <div className="space-y-2">
                        <Label>発生可能性</Label>
                        <Select value={form.likelihood} onValueChange={(v) => v && setForm({ ...form, likelihood: v })}>
                          <SelectTrigger><SelectValue /></SelectTrigger>
                          <SelectContent>
                            {Object.entries(PRIORITIES).map(([k, l]) => <SelectItem key={k} value={k}>{l}</SelectItem>)}
                          </SelectContent>
                        </Select>
                      </div>
                    )}
                    <div className="space-y-2">
                      <Label>優先度</Label>
                      <Select value={form.priority} onValueChange={(v) => v && setForm({ ...form, priority: v })}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {Object.entries(PRIORITIES).map(([k, l]) => <SelectItem key={k} value={k}>{l}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label>担当者</Label>
                    <LabeledSelect
                      value={form.assigneeId}
                      onValueChange={(v) => setForm({ ...form, assigneeId: v ?? '' })}
                      options={Object.fromEntries(members.map((m) => [m.userId, m.userName]))}
                      placeholder="未設定"
                    />
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
          </TableRow>
        </TableHeader>
        <TableBody>
          {risks.map((r) => (
            <TableRow key={r.id}>
              <TableCell><Badge variant="outline">{r.type === 'risk' ? 'リスク' : '課題'}</Badge></TableCell>
              <TableCell className="font-medium">{r.title}</TableCell>
              <TableCell><Badge variant={impactColors[r.impact] || 'secondary'}>{PRIORITIES[r.impact as keyof typeof PRIORITIES]}</Badge></TableCell>
              <TableCell><Badge variant={impactColors[r.priority] || 'secondary'}>{PRIORITIES[r.priority as keyof typeof PRIORITIES]}</Badge></TableCell>
              <TableCell><Badge variant={stateColors[r.state] || 'outline'}>{RISK_ISSUE_STATES[r.state as keyof typeof RISK_ISSUE_STATES]}</Badge></TableCell>
              <TableCell>{r.assigneeName || '-'}</TableCell>
              <TableCell>{new Date(r.createdAt).toLocaleDateString('ja-JP')}</TableCell>
            </TableRow>
          ))}
          {risks.length === 0 && (
            <TableRow><TableCell colSpan={7} className="py-8 text-center text-gray-500">リスク / 課題がありません</TableCell></TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
