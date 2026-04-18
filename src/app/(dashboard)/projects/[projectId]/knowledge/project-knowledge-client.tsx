'use client';

import { useState } from 'react';
import { useLoading } from '@/components/loading-overlay';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { nativeSelectClass } from '@/components/ui/native-select-style';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';
import { Trash2 } from 'lucide-react';
import { KnowledgeEditDialog } from '@/components/dialogs/knowledge-edit-dialog';
import { KNOWLEDGE_TYPES, VISIBILITIES } from '@/types';
import type { KnowledgeDTO } from '@/services/knowledge.service';

type Props = {
  projectId: string;
  knowledges: KnowledgeDTO[];
  canCreate: boolean;
  canDelete: boolean;
  onReload: () => Promise<void> | void;
};

const visibilityColors: Record<string, 'default' | 'secondary' | 'outline'> = {
  draft: 'outline',
  project: 'secondary',
  company: 'default',
};

/**
 * プロジェクト詳細「ナレッジ一覧」タブのクライアントコンポーネント。
 *
 * 役割:
 *   - そのプロジェクトに紐づくナレッジのみ表示 (プロジェクト scoped)
 *   - 作成: /api/projects/[projectId]/knowledge (自動で projectId に紐付け)
 *   - 削除: /api/projects/[projectId]/knowledge/[knowledgeId] (ProjectMember 認可)
 *   - 「全ナレッジ」画面と同一テーブル参照のため、ここでの CRUD は即座に
 *     /knowledge ビューにも反映される
 */
export function ProjectKnowledgeClient({
  projectId,
  knowledges,
  canCreate,
  canDelete,
  onReload,
}: Props) {
  const { withLoading } = useLoading();
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [error, setError] = useState('');
  // Req 8: 行クリックで編集ダイアログ
  const [editingKnowledge, setEditingKnowledge] = useState<KnowledgeDTO | null>(null);

  const initialForm = {
    title: '',
    knowledgeType: 'research',
    background: '',
    content: '',
    result: '',
    visibility: 'draft',
  };
  const [form, setForm] = useState(initialForm);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError('');

    const res = await withLoading(() =>
      fetch(`/api/projects/${projectId}/knowledge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      }),
    );

    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      setError(json.error?.message || json.error?.details?.[0]?.message || '作成に失敗しました');
      return;
    }

    setIsCreateOpen(false);
    setForm(initialForm);
    await onReload();
  }

  async function handleDelete(knowledgeId: string) {
    if (!confirm('このナレッジを削除しますか？')) return;
    const res = await withLoading(() =>
      fetch(`/api/projects/${projectId}/knowledge/${knowledgeId}`, { method: 'DELETE' }),
    );
    if (!res.ok) {
      alert('削除に失敗しました');
      return;
    }
    await onReload();
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold">ナレッジ一覧（{knowledges.length} 件）</h3>
        <div className="flex items-center gap-3">
          <a href="/knowledge" className="text-sm text-blue-600 hover:underline">
            全ナレッジへ →
          </a>
          {canCreate && (
            <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
              <DialogTrigger render={<Button size="sm" />}>ナレッジ作成</DialogTrigger>
              <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
                <DialogHeader>
                  <DialogTitle>ナレッジ作成</DialogTitle>
                  <DialogDescription>
                    このプロジェクトに紐づけて登録されます。「全ナレッジ」にも自動で反映されます。
                  </DialogDescription>
                </DialogHeader>
                <form onSubmit={handleCreate} className="space-y-4">
                  {error && (
                    <div className="rounded-md bg-red-50 p-3 text-sm text-red-600">{error}</div>
                  )}
                  <div className="space-y-2">
                    <Label>タイトル</Label>
                    <Input
                      value={form.title}
                      onChange={(e) => setForm({ ...form, title: e.target.value })}
                      maxLength={150}
                      required
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label>種別</Label>
                      <select
                        value={form.knowledgeType}
                        onChange={(e) => setForm({ ...form, knowledgeType: e.target.value })}
                        className={nativeSelectClass}
                      >
                        {Object.entries(KNOWLEDGE_TYPES).map(([key, label]) => (
                          <option key={key} value={key}>{label}</option>
                        ))}
                      </select>
                    </div>
                    <div className="space-y-2">
                      <Label>公開範囲</Label>
                      <select
                        value={form.visibility}
                        onChange={(e) => setForm({ ...form, visibility: e.target.value })}
                        className={nativeSelectClass}
                      >
                        {Object.entries(VISIBILITIES).map(([key, label]) => (
                          <option key={key} value={key}>{label}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label>背景</Label>
                    <textarea
                      className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      value={form.background}
                      onChange={(e) => setForm({ ...form, background: e.target.value })}
                      rows={3}
                      maxLength={2000}
                      required
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>内容</Label>
                    <textarea
                      className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      value={form.content}
                      onChange={(e) => setForm({ ...form, content: e.target.value })}
                      rows={5}
                      maxLength={5000}
                      required
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>結果</Label>
                    <textarea
                      className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      value={form.result}
                      onChange={(e) => setForm({ ...form, result: e.target.value })}
                      rows={3}
                      maxLength={3000}
                      required
                    />
                  </div>
                  <Button type="submit" className="w-full">作成</Button>
                </form>
              </DialogContent>
            </Dialog>
          )}
        </div>
      </div>

      {knowledges.length === 0 ? (
        <p className="py-8 text-center text-sm text-gray-500">ナレッジがありません</p>
      ) : (
        <div className="space-y-2">
          {knowledges.map((k) => (
            <div
              key={k.id}
              // Req 8: 行クリックで編集ダイアログ (canCreate = メンバー以上で編集可)
              className={`rounded border p-3 ${canCreate ? 'cursor-pointer hover:bg-gray-50' : ''}`}
              onClick={canCreate ? () => setEditingKnowledge(k) : undefined}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{k.title}</span>
                    <Badge variant="secondary" className="text-xs">
                      {KNOWLEDGE_TYPES[k.knowledgeType as keyof typeof KNOWLEDGE_TYPES] || k.knowledgeType}
                    </Badge>
                    <Badge variant={visibilityColors[k.visibility] || 'outline'} className="text-xs">
                      {VISIBILITIES[k.visibility as keyof typeof VISIBILITIES] || k.visibility}
                    </Badge>
                    {k.creatorName && (
                      <span className="text-xs text-gray-400">作成: {k.creatorName}</span>
                    )}
                  </div>
                  <p className="mt-1 text-sm text-gray-600 line-clamp-2">{k.content}</p>
                </div>
                {canDelete && (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="text-red-600 hover:text-red-700"
                    title="削除"
                    aria-label="削除"
                    onClick={(e) => { e.stopPropagation(); handleDelete(k.id); }}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <KnowledgeEditDialog
        knowledge={editingKnowledge}
        projectId={projectId}
        open={editingKnowledge != null}
        onOpenChange={(v) => { if (!v) setEditingKnowledge(null); }}
        onSaved={async () => { await onReload(); }}
      />
    </div>
  );
}
