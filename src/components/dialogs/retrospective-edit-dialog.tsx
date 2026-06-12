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
// readOnly 時は MarkdownTextarea ではなく MarkdownDisplay を直接使う
// (理由: <fieldset disabled> は子孫の <button> もネイティブ disabled にするため、
//  プレビュー/差分トグルが効かず、Markdown が生ソースのまま表示される問題があった。
//  AllMemosClient と同じパターンに揃える)
import { MarkdownTextarea, MarkdownDisplay } from '@/components/ui/markdown-textarea';

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
  // feat/asset-assignee-expansion (2026-05-26): 担当者
  assigneeId?: string | null;
  // PR feat/asset-multi-linking-ui (Phase 2): 紐付け済プロジェクト一覧
  // feat/crud-permission-redesign (2026-05-20): 横断ビューで非 ProjectMember は name=null
  linkedProjects?: { id: string; name: string | null; deleted: boolean }[];
};

/**
 * 振り返り編集ダイアログ (PR #56 Req 8 + 9)。
 * API: PATCH /api/projects/:projectId/retrospectives/:retroId
 */
export function RetrospectiveEditDialog({
  retro,
  members,
  open,
  onOpenChange,
  onSaved,
  readOnly = false,
  closedProject = false,
  currentProjectId,
}: {
  retro: RetroLike | null;
  /** feat/asset-assignee-expansion (2026-05-26): 担当者 selector の選択肢。
   *  未指定時は selector を表示しない (cross-list /retrospectives, suggestions パネル等)。 */
  members?: { userId: string; userName: string }[];
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSaved: () => Promise<void> | void;
  /** PR #61: 非公開プロジェクト用の参照専用モード */
  readOnly?: boolean;
  /** 2026-06-12: クローズ済みプロジェクト経由で開いた場合 true。コメント投稿欄も非表示にする
   *  (readOnly は非所有者の閲覧=コメント可も含むため、コメント遮断は別フラグで判定)。 */
  closedProject?: boolean;
  /** PR feat/asset-multi-linking-ui (Phase 2): ダイアログを開いている画面の projectId
   *  (PATCH URL 構築 + 解除可能 chip の判定に使う)。 */
  currentProjectId?: string | null;
}) {
  const t = useTranslations('action');
  const tField = useTranslations('field');
  const tRetro = useTranslations('retro');
  const tRisk = useTranslations('risk');
  const { withLoading } = useLoading();
  const { showSuccessKey, showErrorKey } = useToast();
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
    // feat/asset-assignee-expansion (2026-05-26)
    assigneeId: '',
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
      assigneeId: retro.assigneeId ?? '',
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
      showErrorKey('retro.toastOrphanError');
      return;
    }
    // 2026-05-11: 「自分のみ (draft)」保存時は conductedDate を空にできる仕様のため、
    //   '' を undefined に変換してから送信する (validator の regex で '' は弾かれるため)。
    //   public 時は UI 側で required により '' での送信は発生しないが、サーバ側 superRefine でも検証される。
    const payload: Record<string, unknown> = { ...form };
    if (form.conductedDate === '') {
      delete payload.conductedDate;
    }
    // feat/asset-assignee-expansion (2026-05-26): 空文字 → null (DB は nullable)
    payload.assigneeId = form.assigneeId || null;
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
      showErrorKey('retro.toastUpdateFailed');
      return;
    }
    // feat/account-lock-and-ui-consistency: 作成 dialog と挙動を揃える。
    // 即座に閉じてから reload を裏で走らせる (旧実装は reload await で遅く感じた)。
    onOpenChange(false);
    showSuccessKey('retro.toastUpdateSuccess');
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
          {/* PR #63: 公開範囲を最上位に配置。2026-06-02: 公開範囲・実施日を 2 列構成に。 */}
          <div className="grid grid-cols-2 gap-4">
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
                  <span className="ml-2 text-xs text-muted-foreground">{tRetro('optional')}</span>
                )}
              </Label>
              <DateFieldWithActions
                value={form.conductedDate}
                onChange={(v) => setForm({ ...form, conductedDate: v })}
                required={form.visibility === 'public'}
                hideClear
              />
            </div>
          </div>
          {/* feat/asset-assignee-expansion (2026-05-26): 担当者 selector (members 受領時のみ表示)。
              作成者と並ぶ編集権限保持者で、引継ぎ完了後の運用者向け。 */}
          {members && members.length > 0 && (
            <div className="space-y-2">
              <Label>{tField('assignee')}</Label>
              <select
                value={form.assigneeId}
                onChange={(e) => setForm({ ...form, assigneeId: e.target.value })}
                className={nativeSelectClass}
              >
                <option value="">{tRisk('notSet')}</option>
                {members.map((m) => <option key={m.userId} value={m.userId}>{m.userName}</option>)}
              </select>
            </div>
          )}
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
              {readOnly ? (
                <div className="rounded-md border border-input bg-background px-3 py-2 text-sm">
                  <MarkdownDisplay value={form[key]} />
                </div>
              ) : (
                <MarkdownTextarea
                  value={form[key]}
                  onChange={(v) => setForm({ ...form, [key]: v })}
                  previousValue={retro[key]}
                  rows={rows}
                  maxLength={3000}
                />
              )}
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
          <CommentSection entityType="retrospective" entityId={retro.id} mutationsLocked={closedProject} />
        </form>
      </DialogContent>
    </Dialog>
  );
}
