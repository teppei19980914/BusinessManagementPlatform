'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useLoading } from '@/components/loading-overlay';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { nativeSelectClass } from '@/components/ui/native-select-style';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { KNOWLEDGE_TYPES, VISIBILITIES } from '@/types';
import { AttachmentList } from '@/components/attachments/attachment-list';
import { SingleUrlField } from '@/components/attachments/single-url-field';

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
  readOnly = false,
}: {
  knowledge: KnowledgeLike | null;
  /** プロジェクトスコープで編集する場合の projectId。省略時はレガシー /api/knowledge/:id を使う */
  projectId?: string | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSaved: () => Promise<void> | void;
  /** PR #61: 非公開プロジェクトの行クリック用 参照専用モード */
  readOnly?: boolean;
}) {
  const t = useTranslations('action');
  const { withLoading } = useLoading();
  const [form, setForm] = useState({
    title: '',
    knowledgeType: 'research',
    background: '',
    content: '',
    result: '',
    visibility: 'draft',
  });
  const [error, setError] = useState('');
  // PR #88: 編集ダイアログを開くたびに DB データを初期表示する。
  // 初期値を null + 閉じた時に null-reset → 別エンティティ切替 / 同一再オープン / 初回マウント
  // いずれでも resync が走る。
  const [prevKnowledgeId, setPrevKnowledgeId] = useState<string | null>(null);
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
  if (!knowledge && prevKnowledgeId !== null) {
    setPrevKnowledgeId(null);
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
    // feat/account-lock-and-ui-consistency: 作成 dialog と挙動を揃える。
    // 即座に閉じてから reload を裏で走らせる (旧実装は reload await で遅く感じた)。
    onOpenChange(false);
    void onSaved();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[min(90vw,36rem)] max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{readOnly ? 'ナレッジ詳細' : 'ナレッジ編集'}</DialogTitle>
          <DialogDescription>
            {readOnly ? '参照専用です (プロジェクト非メンバーのため編集不可)。' : '変更内容を保存します。'}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          {error && <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}
          <fieldset disabled={readOnly} className="space-y-4 disabled:opacity-90">
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
          </fieldset>
          {/* PR #64 Phase 2: 一次情報源 URL (単数) + 参考リンク (複数) */}
          <SingleUrlField
            entityType="knowledge"
            entityId={knowledge.id}
            slot="source"
            canEdit={!readOnly}
            label="一次情報源 URL"
            defaultDisplayName="公式ドキュメント"
          />
          <AttachmentList
            entityType="knowledge"
            entityId={knowledge.id}
            canEdit={!readOnly}
            label="参考リンク"
          />
          {!readOnly && <Button type="submit" className="w-full">{t('save')}</Button>}
        </form>
      </DialogContent>
    </Dialog>
  );
}
