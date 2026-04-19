'use client';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useLoading } from '@/components/loading-overlay';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';
import { RetrospectiveEditDialog } from '@/components/dialogs/retrospective-edit-dialog';
import {
  StagedAttachmentsInput,
  persistStagedAttachments,
  type StagedAttachment,
} from '@/components/attachments/staged-attachments-input';
import { nativeSelectClass } from '@/components/ui/native-select-style';
import { VISIBILITIES } from '@/types';
import type { RetroDTO } from '@/services/retrospective.service';

type Props = {
  projectId: string;
  retros: RetroDTO[];
  canEdit: boolean;
  canComment: boolean;
  /** CRUD 後に呼び出す再取得ハンドラ（未指定時は router.refresh フォールバック）*/
  onReload?: () => Promise<void> | void;
};

export function RetrospectivesClient({ projectId, retros, canEdit, canComment, onReload }: Props) {
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
  const [commentText, setCommentText] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  // 行 (カード) クリックで開く編集ダイアログ (PR #56 Req 8)
  const [editingRetro, setEditingRetro] = useState<RetroDTO | null>(null);

  const [form, setForm] = useState({
    conductedDate: new Date().toISOString().split('T')[0],
    planSummary: '',
    actualSummary: '',
    goodPoints: '',
    problems: '',
    improvements: '',
    visibility: 'draft',
  });

  // PR #67: 作成時にステージする添付 URL
  const [stagedCreateAttachments, setStagedCreateAttachments] = useState<StagedAttachment[]>([]);

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
    // PR #67: 作成成功直後にステージされた添付を一括 POST
    const json = await res.json();
    if (stagedCreateAttachments.length > 0 && json.data?.id) {
      await persistStagedAttachments({
        entityType: 'retrospective',
        entityId: json.data.id,
        items: stagedCreateAttachments,
      });
    }
    setStagedCreateAttachments([]);

    setIsCreateOpen(false);
    setForm({ conductedDate: new Date().toISOString().split('T')[0], planSummary: '', actualSummary: '', goodPoints: '', problems: '', improvements: '', visibility: 'draft' });
    await reload();
  }

  async function handleConfirm(retroId: string) {
    // PR #57 修正: 以前は POST /retrospectives に { action: 'confirm', retroId } を送って
    // 400 (create schema 違反) になっていた。正しい経路である
    // PATCH /retrospectives/[retroId] に state='confirmed' を送る。
    await fetch(`/api/projects/${projectId}/retrospectives/${retroId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: 'confirmed' }),
    });
    await reload();
  }

  async function handleDelete(retroId: string) {
    // PR #59: 振り返りリストからの削除 UI を追加 (リスク/課題・ナレッジと同様の DRY 化)。
    // 実 API は PR #52 で新設済の DELETE /api/projects/:pid/retrospectives/:retroId を使用。
    if (!confirm('この振り返りを削除しますか？')) return;
    const res = await withLoading(() =>
      fetch(`/api/projects/${projectId}/retrospectives/${retroId}`, { method: 'DELETE' }),
    );
    if (!res.ok) {
      alert('削除に失敗しました');
      return;
    }
    await reload();
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
    await reload();
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">振り返り</h2>
        {canEdit && (
          <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
            <DialogTrigger className="inline-flex shrink-0 items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-xs hover:bg-primary/90">振り返り作成</DialogTrigger>
            <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>振り返り作成</DialogTitle>
                <DialogDescription>プロジェクトの振り返りを記録してください。</DialogDescription>
              </DialogHeader>
              <form onSubmit={handleCreate} className="space-y-4">
                {error && <div className="rounded-md bg-red-50 p-3 text-sm text-red-600">{error}</div>}
                {/* PR #63: 公開範囲を最上位に配置 (設定忘れ防止) */}
                <div className="space-y-2">
                  <Label>公開範囲</Label>
                  <select value={form.visibility} onChange={(e) => setForm({ ...form, visibility: e.target.value })} className={nativeSelectClass}>
                    {Object.entries(VISIBILITIES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                  </select>
                </div>
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
                {/* PR #67: 作成と同時に議事録・発表資料等の関連 URL を登録可能 */}
                <StagedAttachmentsInput
                  value={stagedCreateAttachments}
                  onChange={setStagedCreateAttachments}
                />
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
        <div
          key={retro.id}
          className={`rounded-lg border p-6 space-y-4 ${canEdit ? 'cursor-pointer hover:bg-gray-50/50' : ''}`}
          // Req 8: カード自体クリックで編集ダイアログ (内部ボタンは stopPropagation)
          onClick={canEdit ? () => setEditingRetro(retro) : undefined}
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <h3 className="font-semibold">振り返り（{retro.conductedDate}）</h3>
              <Badge variant={retro.state === 'confirmed' ? 'default' : 'outline'}>
                {retro.state === 'confirmed' ? '確定' : '下書き'}
              </Badge>
            </div>
            <div className="flex items-center gap-2">
              {canEdit && retro.state !== 'confirmed' && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={(e) => { e.stopPropagation(); handleConfirm(retro.id); }}
                >確定</Button>
              )}
              {canEdit && (
                <Button
                  variant="outline"
                  size="sm"
                  className="text-red-600"
                  onClick={(e) => { e.stopPropagation(); handleDelete(retro.id); }}
                >削除</Button>
              )}
            </div>
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

          {/* コメント (内部要素はカードクリックの伝播を止める) */}
          <div className="border-t pt-4" onClick={(e) => e.stopPropagation()}>
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

      <RetrospectiveEditDialog
        retro={editingRetro}
        open={editingRetro != null}
        onOpenChange={(v) => { if (!v) setEditingRetro(null); }}
        onSaved={reload}
      />
    </div>
  );
}
