'use client';

/**
 * PromoteRiskToIssueDialog (v1.3.0 資産導線機能):
 *
 *   リスクが実際に発生した際、その内容を引き継いで新しい課題を起票する「昇華」ダイアログ。
 *   元のリスクは変更されず残る (M:N、再昇華の system 側ブロックなし)。
 *
 *   フォーム初期値はリスクの各項目をそのままコピーする (occurrence 等は「考えられる事象」が
 *   「実際に発生した事象」の土台になるという想定)。公開範囲は元リスクの visibility を継承する
 *   (= 呼出元が「公開済みリスクのみ昇華可」を保証しているため、必須項目はすでに満たされている)。
 *
 *   POST /api/promotions/risk-to-issue ({ riskId, projectId, input: createRiskSchema 形状 })
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
import { DateFieldWithActions } from '@/components/ui/date-field-with-actions';
import { IMPACT_LEVELS, VISIBILITIES } from '@/types';
import { NAME_MAX_LENGTH, MEDIUM_TEXT_MAX_LENGTH } from '@/config';
import { MarkdownTextarea } from '@/components/ui/markdown-textarea';

type SourceRisk = {
  id: string;
  title: string;
  occurrence: string | null;
  cause: string | null;
  responsePolicy: string | null;
  content: string;
  impact: string;
  likelihood: string | null;
  assigneeId: string | null;
  deadline: string | null;
  visibility: string;
};

type Props = {
  risk: SourceRisk;
  projectId: string;
  members: { userId: string; userName: string }[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPromoted: () => Promise<void> | void;
};

export function PromoteRiskToIssueDialog({ risk, projectId, members, open, onOpenChange, onPromoted }: Props) {
  const tField = useTranslations('field');
  const tRisk = useTranslations('risk');
  const tPromotion = useTranslations('promotion');
  const { withLoading } = useLoading();
  const { showSuccessKey, showErrorKey } = useToast();

  const [form, setForm] = useState({
    title: risk.title,
    occurrence: risk.occurrence ?? '',
    cause: risk.cause ?? '',
    responsePolicy: risk.responsePolicy ?? '',
    content: risk.content,
    impact: risk.impact,
    likelihood: risk.likelihood ?? 'medium',
    assigneeId: risk.assigneeId ?? '',
    deadline: risk.deadline ?? '',
    visibility: risk.visibility,
  });
  const [error, setError] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    const res = await withLoading(() =>
      fetch('/api/promotions/risk-to-issue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          riskId: risk.id,
          projectId,
          input: {
            type: 'issue',
            title: form.title,
            occurrence: form.occurrence.trim() || null,
            cause: form.cause.trim() || null,
            responsePolicy: form.responsePolicy.trim() || null,
            content: form.content,
            impact: form.impact,
            likelihood: form.likelihood,
            assigneeId: form.assigneeId || null,
            deadline: form.deadline || null,
            visibility: form.visibility,
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
          <DialogTitle>{tPromotion('promoteToIssueDialogTitle')}</DialogTitle>
          <DialogDescription>{tPromotion('promoteToIssueHint')}</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          {error && <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}
          <div className="space-y-2">
            <Label>{tField('title')}</Label>
            <Input
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              maxLength={NAME_MAX_LENGTH}
              required
            />
          </div>
          <div className="space-y-2">
            <Label>{tField('issueOccurrence')}</Label>
            <MarkdownTextarea value={form.occurrence} onChange={(v) => setForm({ ...form, occurrence: v })} rows={3} maxLength={MEDIUM_TEXT_MAX_LENGTH} />
          </div>
          <div className="space-y-2">
            <Label>{tField('issueCause')}</Label>
            <MarkdownTextarea value={form.cause} onChange={(v) => setForm({ ...form, cause: v })} rows={3} maxLength={MEDIUM_TEXT_MAX_LENGTH} />
          </div>
          <div className="space-y-2">
            <Label>{tField('issueCountermeasure')}</Label>
            <MarkdownTextarea value={form.responsePolicy} onChange={(v) => setForm({ ...form, responsePolicy: v })} rows={3} maxLength={MEDIUM_TEXT_MAX_LENGTH} />
          </div>
          <div className="space-y-2">
            <Label>{tField('memo')}</Label>
            <MarkdownTextarea value={form.content} onChange={(v) => setForm({ ...form, content: v })} rows={3} maxLength={MEDIUM_TEXT_MAX_LENGTH} />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>{tField('importance')}</Label>
              <select value={form.impact} onChange={(e) => setForm({ ...form, impact: e.target.value })} className={nativeSelectClass}>
                {Object.entries(IMPACT_LEVELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </div>
            <div className="space-y-2">
              <Label>{tField('urgency')}</Label>
              <select value={form.likelihood} onChange={(e) => setForm({ ...form, likelihood: e.target.value })} className={nativeSelectClass}>
                {Object.entries(IMPACT_LEVELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>{tField('assignee')}</Label>
              <select value={form.assigneeId} onChange={(e) => setForm({ ...form, assigneeId: e.target.value })} className={nativeSelectClass}>
                <option value="">{tRisk('notSet')}</option>
                {members.map((m) => <option key={m.userId} value={m.userId}>{m.userName}</option>)}
              </select>
            </div>
            <div className="space-y-2">
              <Label>{tField('visibility')}</Label>
              <select value={form.visibility} onChange={(e) => setForm({ ...form, visibility: e.target.value })} className={nativeSelectClass}>
                {Object.entries(VISIBILITIES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </div>
          </div>
          <div className="space-y-2">
            <Label>{tField('deadline')}</Label>
            <DateFieldWithActions value={form.deadline} onChange={(v) => setForm({ ...form, deadline: v })} />
          </div>
          <Button type="submit" className="w-full">{tPromotion('promoteButton')}</Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
