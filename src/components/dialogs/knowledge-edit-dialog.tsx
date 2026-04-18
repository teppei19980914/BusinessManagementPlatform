'use client';

import { useState } from 'react';
import { useLoading } from '@/components/loading-overlay';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { nativeSelectClass } from '@/components/ui/native-select-style';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { KNOWLEDGE_TYPES, VISIBILITIES } from '@/types';

type KnowledgeLike = {
  id: string;
  title: string;
  knowledgeType: string;
  background: string;
  content: string;
  result: string;
  visibility: string;
  projectIds?: string[];
  primaryProjectId?: string | null;
};

/**
 * ナレッジ編集ダイアログ (PR #56 Req 8 + 9)。
 *
 * API 経路選択:
 *   - project 指定あり (projectId prop) → PATCH /api/projects/:projectId/knowledge/:knowledgeId
 *     (ProjectMember 認可)
 *   - project 指定なし (全ナレッジから呼ばれ primaryProjectId が null のレガシーデータ)
 *     → PATCH /api/knowledge/:knowledgeId (admin or 作成者)
 */
export function KnowledgeEditDialog({
  knowledge,
  projectId,
  open,
  onOpenChange,
  onSaved,
}: {
  knowledge: KnowledgeLike | null;
  /** プロジェクトスコープで編集する場合の projectId。省略時はレガシー /api/knowledge/:id を使う */
  projectId?: string | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSaved: () => Promise<void> | void;
}) {
  const { withLoading } = useLoading();
  const [form, setForm] = useState({
    title: '',
    knowledgeType: 'research',
    background: '',
    content: '',
    result: '',
    visibility: 'project',
  });
  const [error, setError] = useState('');
  // Derived State パターン: knowledge が切り替わったら form を同期
  const [prevKnowledgeId, setPrevKnowledgeId] = useState<string | null>(knowledge?.id ?? null);
  if (knowledge && knowledge.id !== prevKnowledgeId) {
    setPrevKnowledgeId(knowledge.id);
    setForm({
      title: knowledge.title,
      knowledgeType: knowledge.knowledgeType,
      background: knowledge.background,
      content: knowledge.content,
      result: knowledge.result,
      visibility: knowledge.visibility,
    });
    setError('');
  }

  if (!knowledge) return null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!knowledge) return;
    setError('');
    const url = projectId
      ? `/api/projects/${projectId}/knowledge/${knowledge.id}`
      : `/api/knowledge/${knowledge.id}`;
    const res = await withLoading(() =>
      fetch(url, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      }),
    );
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      setError(json.error?.message || '更新に失敗しました');
      return;
    }
    await onSaved();
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>ナレッジ編集</DialogTitle>
          <DialogDescription>変更内容を保存します。</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          {error && <div className="rounded-md bg-red-50 p-3 text-sm text-red-600">{error}</div>}
          <div className="space-y-2">
            <Label>タイトル</Label>
            <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} maxLength={150} required />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>種別</Label>
              <select value={form.knowledgeType} onChange={(e) => setForm({ ...form, knowledgeType: e.target.value })} className={nativeSelectClass}>
                {Object.entries(KNOWLEDGE_TYPES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </div>
            <div className="space-y-2">
              <Label>公開範囲</Label>
              <select value={form.visibility} onChange={(e) => setForm({ ...form, visibility: e.target.value })} className={nativeSelectClass}>
                {Object.entries(VISIBILITIES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </div>
          </div>
          <div className="space-y-2">
            <Label>背景</Label>
            <textarea
              className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
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
              className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
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
              className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={form.result}
              onChange={(e) => setForm({ ...form, result: e.target.value })}
              rows={3}
              maxLength={3000}
              required
            />
          </div>
          <Button type="submit" className="w-full">保存</Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
