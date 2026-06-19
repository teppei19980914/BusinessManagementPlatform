'use client';

/**
 * PromoteIssueToKnowledgeDialog (v1.3.0 資産導線機能):
 *
 *   課題が解決した際、その内容を引き継いで新しいナレッジを起票する「昇華」ダイアログ。
 *   元の課題は変更されず残る (M:N、再昇華の system 側ブロックなし)。
 *
 *   フォーム初期値: 背景 ← 発生事象 (occurrence) / 内容 ← 対応策 (responsePolicy) / 結果 ← 結果 (result)。
 *   result は課題側で public 化必須項目に含まれない (Embedding 対象外) ため空の可能性があり、
 *   ナレッジの public 化必須項目 (background/content/result) を満たすとは限らない。そのため
 *   公開範囲は安全側で 'draft' 固定初期値とし、ユーザが内容確認後に明示的に切り替える想定。
 *
 *   POST /api/promotions/issue-to-knowledge ({ issueId, input: createKnowledgeSchema 形状 })
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useLoading } from '@/components/loading-overlay';
import { useToast } from '@/components/toast-provider';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { nativeSelectClass } from '@/components/ui/native-select-style';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { KNOWLEDGE_TYPES, VISIBILITIES } from '@/types';
import { TITLE_MAX_LENGTH } from '@/config';
import { MarkdownTextarea } from '@/components/ui/markdown-textarea';

type SourceIssue = {
  id: string;
  title: string;
  occurrence: string | null;
  responsePolicy: string | null;
  result: string | null;
};

type Props = {
  issue: SourceIssue;
  /** ナレッジを紐付けるプロジェクト (任意。null の場合 projectIds は空配列で送信) */
  projectId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPromoted: () => Promise<void> | void;
};

export function PromoteIssueToKnowledgeDialog({ issue, projectId, open, onOpenChange, onPromoted }: Props) {
  const tKnowledge = useTranslations('knowledge');
  const tPromotion = useTranslations('promotion');
  const { withLoading } = useLoading();
  const { showSuccessKey, showErrorKey } = useToast();

  const [form, setForm] = useState({
    title: issue.title,
    knowledgeType: 'lesson',
    background: issue.occurrence ?? '',
    content: issue.responsePolicy ?? '',
    result: issue.result ?? '',
    visibility: 'draft',
  });
  const [error, setError] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    const res = await withLoading(() =>
      fetch('/api/promotions/issue-to-knowledge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          issueId: issue.id,
          input: {
            title: form.title,
            knowledgeType: form.knowledgeType,
            background: form.background,
            content: form.content,
            result: form.result,
            visibility: form.visibility,
            projectIds: projectId ? [projectId] : [],
          },
        }),
      }),
    );
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      const msg = json.error?.message || json.error?.details?.[0]?.message || tPromotion('promoteFailed');
      setError(msg);
      showErrorKey('promotion.promoteFailed');
      return;
    }
    onOpenChange(false);
    showSuccessKey('promotion.promoteSuccess');
    void onPromoted();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[min(90vw,36rem)] max-h-[85vh] overflow-x-hidden overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{tPromotion('promoteToKnowledgeDialogTitle')}</DialogTitle>
          <DialogDescription>{tPromotion('promoteToKnowledgeHint')}</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          {error && <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>{tKnowledge('visibility')}</Label>
              <select value={form.visibility} onChange={(e) => setForm({ ...form, visibility: e.target.value })} className={nativeSelectClass}>
                {Object.entries(VISIBILITIES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </div>
            <div className="space-y-2">
              <Label>{tKnowledge('kind')}</Label>
              <select value={form.knowledgeType} onChange={(e) => setForm({ ...form, knowledgeType: e.target.value })} className={nativeSelectClass}>
                {Object.entries(KNOWLEDGE_TYPES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </div>
          </div>
          <div className="space-y-2">
            <Label>{tKnowledge('fieldTitle')}</Label>
            <Input
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              maxLength={TITLE_MAX_LENGTH}
              required
            />
          </div>
          <div className="space-y-2">
            <Label>{tKnowledge('background')}</Label>
            <MarkdownTextarea value={form.background} onChange={(v) => setForm({ ...form, background: v })} rows={3} maxLength={2000} />
          </div>
          <div className="space-y-2">
            <Label>{tKnowledge('content')}</Label>
            <MarkdownTextarea value={form.content} onChange={(v) => setForm({ ...form, content: v })} rows={5} maxLength={5000} />
          </div>
          <div className="space-y-2">
            <Label>{tKnowledge('result')}</Label>
            <MarkdownTextarea value={form.result} onChange={(v) => setForm({ ...form, result: v })} rows={3} maxLength={3000} />
          </div>
          <Button type="submit" className="w-full">{tPromotion('promoteButton')}</Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
