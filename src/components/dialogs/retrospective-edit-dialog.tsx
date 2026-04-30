'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useLoading } from '@/components/loading-overlay';
import { useToast } from '@/components/toast-provider';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { nativeSelectClass } from '@/components/ui/native-select-style';
import { VISIBILITIES } from '@/types';
import { DialogAttachmentSection } from '@/components/common/dialog-attachment-section';
// PR #199: コメントセクション (旧 retrospective_comments を polymorphic comments テーブルに統合)
import { CommentSection } from '@/components/comments/comment-section';
import { DateFieldWithActions } from '@/components/ui/date-field-with-actions';
// feat/dialog-fullscreen-toggle: 文字量が多い編集 dialog 向けの全画面トグル
import { useDialogFullscreen } from '@/components/ui/use-dialog-fullscreen';
// feat/markdown-textarea: Markdown 入力 + プレビュー + 既存値との差分表示
import { MarkdownTextarea } from '@/components/ui/markdown-textarea';

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
  const tRetro = useTranslations('retro');
  const { withLoading } = useLoading();
  const { showSuccess, showError } = useToast();
  // feat/dialog-fullscreen-toggle: 全画面トグル (90vw × 90vh)
  const { fullscreenClassName, FullscreenToggle } = useDialogFullscreen();
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
      const msg = json.error?.message || tRetro('updateFailed');
      setError(msg);
      showError('振り返りの更新に失敗しました');
      return;
    }
    // feat/account-lock-and-ui-consistency: 作成 dialog と挙動を揃える。
    // 即座に閉じてから reload を裏で走らせる (旧実装は reload await で遅く感じた)。
    onOpenChange(false);
    showSuccess('振り返りを更新しました');
    void onSaved();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={`max-w-[min(90vw,42rem)] max-h-[85vh] overflow-y-auto ${fullscreenClassName}`}>
        <DialogHeader>
          <div className="flex items-center justify-between gap-2">
            <DialogTitle>{readOnly ? tRetro('detailTitle') : tRetro('editTitle')}</DialogTitle>
            <FullscreenToggle />
          </div>
          <DialogDescription>
            {readOnly ? tRetro('readOnlyHint') : tRetro('saveHint')}
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
          {/* refactor/list-create-content-optional (2026-04-27 #6): 5 セクションは全て任意 */}
          {([
            { key: 'planSummary', label: tRetro('planSummary'), rows: 3 },
            { key: 'actualSummary', label: tRetro('actualSummary'), rows: 3 },
            { key: 'goodPoints', label: tRetro('goodPoints'), rows: 3 },
            { key: 'problems', label: tRetro('issuesSection'), rows: 3 },
            { key: 'improvements', label: tRetro('improvementsTable'), rows: 3 },
          ] as const).map(({ key, label, rows }) => (
            <div key={key} className="space-y-2">
              <Label>{label} <span className="text-xs text-muted-foreground">{tRetro('optional')}</span></Label>
              <MarkdownTextarea
                value={form[key]}
                onChange={(v) => setForm({ ...form, [key]: v })}
                previousValue={retro[key]}
                rows={rows}
                maxLength={3000}
              />
            </div>
          ))}
          </fieldset>
          {/* Phase E 共通化: DialogAttachmentSection に集約。readOnly 非表示は §5.10 由来 */}
          <DialogAttachmentSection
            entityType="retrospective"
            entityId={retro.id}
            readOnly={readOnly}
            mainLabel={tRetro('relatedUrl')}
          />
          {!readOnly && <Button type="submit" className="w-full">{t('save')}</Button>}
          {/* PR #199: コメント。fieldset disabled の外に配置することで readOnly でも投稿可。 */}
          <CommentSection entityType="retrospective" entityId={retro.id} />
        </form>
      </DialogContent>
    </Dialog>
  );
}
