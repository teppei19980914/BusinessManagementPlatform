'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useLoading } from '@/components/loading-overlay';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { nativeSelectClass } from '@/components/ui/native-select-style';
import { VISIBILITIES } from '@/types';
import { AttachmentList } from '@/components/attachments/attachment-list';
import { DateFieldWithActions } from '@/components/ui/date-field-with-actions';

type RetroLike = {
  id: string;
  projectId: string;
  conductedDate: string;
  planSummary: string;
  actualSummary: string;
  goodPoints: string;
  problems: string;
  improvements: string;
  visibility: string;
};

/**
 * 振り返り編集ダイアログ (PR #56 Req 8 + 9)。
 * API: PATCH /api/projects/:projectId/retrospectives/:retroId
 */
export function RetrospectiveEditDialog({
  retro,
  open,
  onOpenChange,
  onSaved,
  readOnly = false,
}: {
  retro: RetroLike | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSaved: () => Promise<void> | void;
  /** PR #61: 非公開プロジェクト用の参照専用モード */
  readOnly?: boolean;
}) {
  const t = useTranslations('action');
  const tField = useTranslations('field');
  const { withLoading } = useLoading();
  const [form, setForm] = useState({
    conductedDate: '',
    planSummary: '',
    actualSummary: '',
    goodPoints: '',
    problems: '',
    improvements: '',
    visibility: 'draft',
  });
  const [error, setError] = useState('');
  // PR #88: 編集ダイアログを開くたびに DB データを初期表示する。
  // 初期値を null + 閉じた時に null-reset → 別エンティティ切替 / 同一再オープン / 初回マウント
  // いずれでも resync が走る。
  const [prevRetroId, setPrevRetroId] = useState<string | null>(null);
  if (retro && retro.id !== prevRetroId) {
    setPrevRetroId(retro.id);
    setForm({
      conductedDate: retro.conductedDate,
      planSummary: retro.planSummary,
      actualSummary: retro.actualSummary,
      goodPoints: retro.goodPoints,
      problems: retro.problems,
      improvements: retro.improvements,
      visibility: retro.visibility,
    });
    setError('');
  }
  if (!retro && prevRetroId !== null) {
    setPrevRetroId(null);
  }

  if (!retro) return null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!retro) return;
    setError('');
    const res = await withLoading(() =>
      fetch(`/api/projects/${retro.projectId}/retrospectives/${retro.id}`, {
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
      <DialogContent className="max-w-[min(90vw,42rem)] max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{readOnly ? '振り返り詳細' : '振り返り編集'}</DialogTitle>
          <DialogDescription>
            {readOnly ? '参照専用です (プロジェクト非メンバーのため編集不可)。' : '変更内容を保存します。'}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          {error && <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}
          <fieldset disabled={readOnly} className="space-y-4 disabled:opacity-90">
          {/* PR #63: 公開範囲を最上位に配置 */}
          <div className="space-y-2">
            <Label>{tField('visibility')}</Label>
            <select value={form.visibility} onChange={(e) => setForm({ ...form, visibility: e.target.value })} className={nativeSelectClass}>
              {Object.entries(VISIBILITIES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </div>
          <div className="space-y-2">
            <Label>{tField('conductedDate')}</Label>
            <DateFieldWithActions value={form.conductedDate} onChange={(v) => setForm({ ...form, conductedDate: v })} required hideClear />
          </div>
          {[
            { key: 'planSummary', label: '計画総括', rows: 3 },
            { key: 'actualSummary', label: '実績総括', rows: 3 },
            { key: 'goodPoints', label: '良かった点', rows: 3 },
            { key: 'problems', label: '課題', rows: 3 },
            { key: 'improvements', label: '次回以前事項', rows: 3 },
          ].map(({ key, label, rows }) => (
            <div key={key} className="space-y-2">
              <Label>{label}</Label>
              <textarea
                className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={form[key as keyof typeof form]}
                onChange={(e) => setForm({ ...form, [key]: e.target.value })}
                rows={rows}
                maxLength={3000}
              />
            </div>
          ))}
          </fieldset>
          {/* PR #64 Phase 2: 議事録・発表資料等の関連 URL */}
          <AttachmentList
            entityType="retrospective"
            entityId={retro.id}
            canEdit={!readOnly}
            label="関連 URL"
          />
          {!readOnly && <Button type="submit" className="w-full">{t('save')}</Button>}
        </form>
      </DialogContent>
    </Dialog>
  );
}
