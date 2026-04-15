'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useLoading } from '@/components/loading-overlay';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';
import type { RetroDTO } from '@/services/retrospective.service';

type Props = {
  projectId: string;
  retros: RetroDTO[];
  canEdit: boolean;
  canComment: boolean;
};

export function RetrospectivesClient({ projectId, retros, canEdit, canComment }: Props) {
  const router = useRouter();
  const { withLoading } = useLoading();
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [commentText, setCommentText] = useState<Record<string, string>>({});
  const [error, setError] = useState('');

  const [form, setForm] = useState({
    conductedDate: new Date().toISOString().split('T')[0],
    planSummary: '',
    actualSummary: '',
    goodPoints: '',
    problems: '',
    improvements: '',
  });

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    const res = await withLoading(() =>
      fetch(`/api/projects/${projectId}/retrospectives`, {
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
    setForm({ conductedDate: new Date().toISOString().split('T')[0], planSummary: '', actualSummary: '', goodPoints: '', problems: '', improvements: '' });
    router.refresh();
  }

  async function handleConfirm(retroId: string) {
    await fetch(`/api/projects/${projectId}/retrospectives`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'confirm', retroId }),
    });
    router.refresh();
  }

  async function handleComment(retroId: string) {
    const content = commentText[retroId];
    if (!content?.trim()) return;
    await fetch(`/api/projects/${projectId}/retrospectives/${retroId}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    setCommentText({ ...commentText, [retroId]: '' });
    router.refresh();
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">振り返り</h2>
        {canEdit && (
          <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
            <DialogTrigger><Button>振り返り作成</Button></DialogTrigger>
            <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>振り返り作成</DialogTitle>
                <DialogDescription>プロジェクトの振り返りを記録してください。</DialogDescription>
              </DialogHeader>
              <form onSubmit={handleCreate} className="space-y-4">
                {error && <div className="rounded-md bg-red-50 p-3 text-sm text-red-600">{error}</div>}
                <div className="space-y-2">
                  <Label>実施日</Label>
                  <Input type="date" value={form.conductedDate} onChange={(e) => setForm({ ...form, conductedDate: e.target.value })} required />
                </div>
                <div className="space-y-2">
                  <Label>計画総括</Label>
                  <textarea className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={form.planSummary} onChange={(e) => setForm({ ...form, planSummary: e.target.value })} rows={3} maxLength={2000} required />
                </div>
                <div className="space-y-2">
                  <Label>実績総括</Label>
                  <textarea className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={form.actualSummary} onChange={(e) => setForm({ ...form, actualSummary: e.target.value })} rows={3} maxLength={2000} required />
                </div>
                <div className="space-y-2">
                  <Label>良かった点</Label>
                  <textarea className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={form.goodPoints} onChange={(e) => setForm({ ...form, goodPoints: e.target.value })} rows={3} maxLength={3000} required />
                </div>
                <div className="space-y-2">
                  <Label>問題点</Label>
                  <textarea className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={form.problems} onChange={(e) => setForm({ ...form, problems: e.target.value })} rows={3} maxLength={3000} required />
                </div>
                <div className="space-y-2">
                  <Label>次回改善事項</Label>
                  <textarea className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={form.improvements} onChange={(e) => setForm({ ...form, improvements: e.target.value })} rows={3} maxLength={3000} required />
                </div>
                <Button type="submit" className="w-full">作成</Button>
              </form>
            </DialogContent>
          </Dialog>
        )}
      </div>

      {retros.length === 0 && (
        <p className="py-8 text-center text-gray-500">振り返りがありません</p>
      )}

      {retros.map((retro) => (
        <div key={retro.id} className="rounded-lg border p-6 space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <h3 className="font-semibold">振り返り（{retro.conductedDate}）</h3>
              <Badge variant={retro.state === 'confirmed' ? 'default' : 'outline'}>
                {retro.state === 'confirmed' ? '確定' : '下書き'}
              </Badge>
            </div>
            {canEdit && retro.state !== 'confirmed' && (
              <Button variant="outline" size="sm" onClick={() => handleConfirm(retro.id)}>確定</Button>
            )}
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <h4 className="text-sm font-medium text-gray-500">良かった点</h4>
              <p className="mt-1 whitespace-pre-wrap text-sm">{retro.goodPoints}</p>
            </div>
            <div>
              <h4 className="text-sm font-medium text-gray-500">問題点</h4>
              <p className="mt-1 whitespace-pre-wrap text-sm">{retro.problems}</p>
            </div>
            <div className="md:col-span-2">
              <h4 className="text-sm font-medium text-gray-500">次回改善事項</h4>
              <p className="mt-1 whitespace-pre-wrap text-sm">{retro.improvements}</p>
            </div>
          </div>

          {/* コメント */}
          <div className="border-t pt-4">
            <h4 className="text-sm font-medium text-gray-500 mb-2">コメント（{retro.comments.length}件）</h4>
            {retro.comments.map((c) => (
              <div key={c.id} className="mb-2 rounded bg-gray-50 p-2 text-sm">
                <span className="font-medium">{c.userName}</span>
                <span className="ml-2 text-xs text-gray-400">{new Date(c.createdAt).toLocaleString('ja-JP')}</span>
                <p className="mt-1">{c.content}</p>
              </div>
            ))}
            {canComment && (
              <div className="flex gap-2 mt-2">
                <Input
                  placeholder="コメントを入力..."
                  value={commentText[retro.id] || ''}
                  onChange={(e) => setCommentText({ ...commentText, [retro.id]: e.target.value })}
                  onKeyDown={(e) => e.key === 'Enter' && handleComment(retro.id)}
                />
                <Button variant="outline" size="sm" onClick={() => handleComment(retro.id)}>投稿</Button>
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
