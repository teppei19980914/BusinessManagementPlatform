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
// PR feat/asset-multi-linking-ui (Phase 2): 紐付け済プロジェクト表示 + 解除ボタン
import { LinkedProjectsSection } from '@/components/common/linked-projects-section';
// PR #199: コメントセクション (旧 retrospective_comments を polymorphic comments テーブルに統合)
import { CommentSection } from '@/components/comments/comment-section';
import { DateFieldWithActions } from '@/components/ui/date-field-with-actions';
// feat/dialog-fullscreen-toggle: 文字量が多い編集 dialog 向けの全画面トグル
import { useDialogFullscreen } from '@/components/ui/use-dialog-fullscreen';
// feat/markdown-textarea: Markdown 入力 + プレビュー + 既存値との差分表示
import { MarkdownTextarea } from '@/components/ui/markdown-textarea';

type RetroLike = {
  id: string;
  // PR feat/asset-multi-project-linking: 「作成元」projectId は M:N 化で nullable に
  projectId: string | null;
  conductedDate: string;
  planSummary: string;
  actualSummary: string;
  goodPoints: string;
  problems: string;
  improvements: string;
  visibility: string;
  // PR feat/asset-multi-linking-ui (Phase 2): 紐付け済プロジェクト一覧
  linkedProjects?: { id: string; name: string; deleted: boolean }[];
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
  currentProjectId,
}: {
  retro: RetroLike | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSaved: () => Promise<void> | void;
  /** PR #61: 非公開プロジェクト用の参照専用モード */
  readOnly?: boolean;
  /** PR feat/asset-multi-linking-ui (Phase 2): ダイアログを開いている画面の projectId
   *  (PATCH URL 構築 + 解除可能 chip の判定に使う)。 */
  currentProjectId?: string | null;
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
    // PR feat/asset-multi-linking-ui (Phase 2): currentProjectId を最優先 (UI 文脈の project)
    const targetProjectId =
      currentProjectId ?? retro.projectId ?? retro.linkedProjects?.[0]?.id ?? null;
    if (!targetProjectId) {
      setError(tRetro('updateFailed'));
      showError('編集対象プロジェクトが特定できません (孤児状態)');
      return;
    }
    // 2026-05-11: 「自分のみ (draft)」保存時は conductedDate を空にできる仕様のため、
    //   '' を undefined に変換してから送信する (validator の regex で '' は弾かれるため)。
    //   public 時は UI 側で required により '' での送信は発生しないが、サーバ側 superRefine でも検証される。
    const payload: Record<string, unknown> = { ...form };
    if (form.conductedDate === '') {
      delete payload.conductedDate;
    }
    const res = await withLoading(() =>
      fetch(`/api/projects/${targetProjectId}/retrospectives/${retro.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
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
      <DialogContent className={`max-w-[min(90vw,42rem)] max-h-[85vh] overflow-x-hidden overflow-y-auto ${fullscreenClassName}`}>
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
            <Label>
              {tField('conductedDate')}
              {/* 2026-05-11: 公開範囲 = 自分のみ (draft) なら任意。空のまま draft 保存可 (= サーバ側で当日日付が default 補完される) */}
              {form.visibility === 'draft' && (
                <span className="ml-2 text-xs text-muted-foreground">(任意)</span>
              )}
            </Label>
            <DateFieldWithActions
              value={form.conductedDate}
              onChange={(v) => setForm({ ...form, conductedDate: v })}
              required={form.visibility === 'public'}
              hideClear
            />
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
          {/* Phase E 共通化: DialogAttachmentSection に集約。readOnly 非表示は §5.14 由来 */}
          <DialogAttachmentSection
            entityType="retrospective"
            entityId={retro.id}
            readOnly={readOnly}
            mainLabel={tRetro('relatedUrl')}
          />
          {/* PR feat/asset-multi-linking-ui (Phase 2): 紐付け先プロジェクト一覧 */}
          {retro.linkedProjects && (
            <LinkedProjectsSection
              entityType="retrospective"
              entityId={retro.id}
              linkedProjects={retro.linkedProjects}
              currentProjectId={currentProjectId ?? null}
              onChanged={onSaved}
            />
          )}
          {!readOnly && <Button type="submit" className="w-full">{t('save')}</Button>}
          {/* PR #199: コメント。fieldset disabled の外に配置することで readOnly でも投稿可。 */}
          <CommentSection entityType="retrospective" entityId={retro.id} />
        </form>
      </DialogContent>
    </Dialog>
  );
}
