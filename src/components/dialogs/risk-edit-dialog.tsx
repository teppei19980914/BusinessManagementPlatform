'use client';

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
import { IMPACT_LEVELS, RISK_ISSUE_STATES, VISIBILITIES, RISK_NATURES } from '@/types';
import { NAME_MAX_LENGTH, MEDIUM_TEXT_MAX_LENGTH } from '@/config';
import { DialogAttachmentSection } from '@/components/common/dialog-attachment-section';
// PR feat/asset-multi-linking-ui (Phase 2): 紐付け済プロジェクト表示 + 解除ボタン
import { LinkedProjectsSection } from '@/components/common/linked-projects-section';
// PR #199: コメントセクション (entityType は risk.type='risk'|'issue' に追従)
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

/**
 * リスク/課題の編集に必要な最小限の形状。RiskDTO / AllRiskDTO 両方と互換。
 */
type RiskLike = {
  id: string;
  // PR feat/asset-multi-project-linking: 「作成元」projectId は M:N 化で nullable に
  projectId: string | null;
  type: string;
  title: string;
  // feat/risk-issue-4-section (2026-05-26): 4 セクション化
  //   - occurrence : 発生事象 (issue) / 考えられる事象 (risk)
  //   - cause      : 直接原因 (issue) / 考えられる原因 (risk)
  //   - responsePolicy : 対応策 (issue) / 考えられる対応策 (risk)
  //   - content    : メモ (両 type 共通、旧「内容」のリネーム)
  occurrence: string | null;
  cause: string | null;
  responsePolicy: string | null;
  content: string;
  impact: string;
  likelihood: string | null;
  priority: string;
  state: string;
  assigneeId: string | null;
  deadline: string | null;
  visibility: string;
  riskNature: string | null;
  // 2026-06-02: 結果を編集可能に追加
  result: string | null;
  // PR feat/asset-multi-linking-ui (Phase 2): 紐付け済プロジェクト一覧
  // feat/crud-permission-redesign (2026-05-20): 横断ビューで非 ProjectMember は name=null
  linkedProjects?: { id: string; name: string | null; deleted: boolean }[];
};

/**
 * 行クリックで開く汎用編集ダイアログ。
 * ○○一覧 / 全○○ の両方で使う (PR #56 Req 8 + 9)。
 *
 * API 経路: PATCH /api/projects/:projectId/risks/:riskId
 *   admin は checkMembership で全プロジェクト pm_tl 相当、非 admin は
 *   メンバーのみ通過する (呼び出し側で canEdit ガードも推奨)。
 */
export function RiskEditDialog({
  risk,
  members,
  open,
  onOpenChange,
  onSaved,
  readOnly = false,
  closedProject = false,
  currentProjectId,
}: {
  risk: RiskLike | null;
  members: { userId: string; userName: string }[];
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSaved: () => Promise<void> | void;
  /** PR #61: 非公開プロジェクトの行クリック時など、参照専用で開く場合に true */
  readOnly?: boolean;
  /** 2026-06-12: クローズ済みプロジェクト経由で開いた場合 true。コメント投稿欄も非表示にする
   *  (readOnly は非所有者の閲覧=コメント可も含むため、コメント遮断は別フラグで判定)。 */
  closedProject?: boolean;
  /** PR feat/asset-multi-linking-ui (Phase 2): ダイアログを開いている画面のプロジェクト ID。
   *  /projects/X/risks → X、/risks (全リスク横断) → null。
   *  PATCH の URL 構築 (作成元 project が削除済の場合の fallback) と
   *  LinkedProjectsSection の解除可能 chip の判定に使う。 */
  currentProjectId?: string | null;
}) {
  const t = useTranslations('action');
  const tField = useTranslations('field');
  const tRisk = useTranslations('risk');
  const { withLoading } = useLoading();
  const { showSuccessKey, showErrorKey } = useToast();
  // feat/dialog-fullscreen-toggle: 全画面トグル (90vw × 90vh)。state は dialog ローカル。
  const { fullscreenClassName, FullscreenToggle } = useDialogFullscreen();
  const [form, setForm] = useState({
    title: '',
    // feat/risk-issue-4-section (2026-05-26): 4 セクション化
    occurrence: '',
    cause: '',
    responsePolicy: '',
    content: '',
    impact: 'medium',
    likelihood: 'medium',
    // PR #63: 優先度は UI から撤去 (将来 impact × likelihood で自動算出予定)
    state: 'open',
    assigneeId: '',
    deadline: '',
    visibility: 'draft',
    riskNature: 'threat',
    // 2026-06-02: 結果を編集可能に追加 (公開後の結果記録)。
    result: '',
  });
  const [error, setError] = useState('');
  // PR #88: 編集ダイアログを開くたびに DB データを初期表示する。
  // prevRiskId の初期値を null にし、閉じた時に null-reset を入れることで、
  // 別エンティティ切替 / 同一エンティティ再オープン / 初回マウントいずれでも resync が走る。
  const [prevRiskId, setPrevRiskId] = useState<string | null>(null);
  if (risk && risk.id !== prevRiskId) {
    setPrevRiskId(risk.id);
    setForm({
      title: risk.title,
      // feat/risk-issue-4-section (2026-05-26): 4 セクション化
      occurrence: risk.occurrence ?? '',
      cause: risk.cause ?? '',
      responsePolicy: risk.responsePolicy ?? '',
      content: risk.content,
      impact: risk.impact,
      likelihood: risk.likelihood ?? 'medium',
      state: risk.state,
      assigneeId: risk.assigneeId ?? '',
      deadline: risk.deadline ?? '',
      visibility: risk.visibility,
      riskNature: risk.riskNature ?? 'threat',
      result: risk.result ?? '',
    });
    setError('');
  }
  if (!risk && prevRiskId !== null) {
    setPrevRiskId(null);
  }

  if (!risk) return null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!risk) return;
    setError('');
    // PR #63: 優先度は UI から撤去したため送信しない (既存値を維持)
    // feat/risk-issue-4-section (2026-05-26): 4 セクション (occurrence/cause/responsePolicy/content)
    //   を送信。空文字は null として保存 (DB は nullable)。
    const body: Record<string, unknown> = {
      title: form.title,
      occurrence: form.occurrence.trim() || null,
      cause: form.cause.trim() || null,
      responsePolicy: form.responsePolicy.trim() || null,
      content: form.content,
      impact: form.impact,
      state: form.state,
      assigneeId: form.assigneeId || null,
      deadline: form.deadline || null,
      visibility: form.visibility,
      result: form.result.trim() || null,
    };
    if (risk.type === 'risk') {
      body.likelihood = form.likelihood;
      body.riskNature = form.riskNature;
    }

    // PR feat/asset-multi-linking-ui (Phase 2): currentProjectId を最優先 (UI 文脈の project)。
    //   作成元が削除済 → fallback で linkedProjects[0]。両方無い orphan は読み取り専用想定なので
    //   実質発生しない (PATCH URL は member 認可を通過する project が必須)。
    const targetProjectId =
      currentProjectId ?? risk.projectId ?? risk.linkedProjects?.[0]?.id ?? null;
    if (!targetProjectId) {
      setError(tRisk('updateFailed'));
      showErrorKey('risk.toastOrphanError');
      return;
    }
    const res = await withLoading(() =>
      fetch(`/api/projects/${targetProjectId}/risks/${risk.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      const msg = json.error?.message || json.error?.details?.[0]?.message || tRisk('updateFailed');
      setError(msg);
      showErrorKey(risk.type === 'risk' ? 'risk.toastRiskUpdateFailed' : 'risk.toastIssueUpdateFailed');
      return;
    }
    // feat/account-lock-and-ui-consistency: 作成 dialog と挙動を揃える。
    // 旧実装: await onSaved() → onOpenChange(false) — reload 完了を待つため遅く感じる
    // 新実装: onOpenChange(false) → onSaved() (fire-and-forget) — 即座に閉じて裏で reload
    onOpenChange(false);
    showSuccessKey(risk.type === 'risk' ? 'risk.toastRiskUpdateSuccess' : 'risk.toastIssueUpdateSuccess');
    void onSaved();
  }

  const dialogTitle = readOnly
    ? (risk.type === 'risk' ? tRisk('detailRisk') : tRisk('detailIssue'))
    : (risk.type === 'risk' ? tRisk('editRisk') : tRisk('editIssue'));
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={`max-w-[min(90vw,36rem)] max-h-[80vh] overflow-x-hidden overflow-y-auto ${fullscreenClassName}`}>
        <DialogHeader>
          <div className="flex items-center justify-between gap-2">
            <DialogTitle>{dialogTitle}</DialogTitle>
            <FullscreenToggle />
          </div>
          <DialogDescription>
            {readOnly ? tRisk('readOnlyHint') : tRisk('saveHint')}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          {error && <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}
          <fieldset disabled={readOnly} className="space-y-4 disabled:opacity-90">
          {/* PR #63: 公開範囲 / 脅威・好機 を最上位に配置 */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>{tField('visibility')}</Label>
              <select value={form.visibility} onChange={(e) => setForm({ ...form, visibility: e.target.value })} className={nativeSelectClass}>
                {Object.entries(VISIBILITIES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </div>
            {risk.type === 'risk' && (
              <div className="space-y-2">
                <Label>{tField('riskNature')}</Label>
                <select value={form.riskNature} onChange={(e) => setForm({ ...form, riskNature: e.target.value })} className={nativeSelectClass}>
                  {Object.entries(RISK_NATURES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
              </div>
            )}
          </div>
          <div className="space-y-2">
            <Label>
              {tField('title')}
              {/* 2026-05-11: 公開範囲 = 自分のみ (draft) なら任意、全メンバー (public) なら必須 */}
              {form.visibility === 'draft' && (
                <span className="ml-2 text-xs text-muted-foreground">{tRisk('optional')}</span>
              )}
            </Label>
            <Input
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              maxLength={NAME_MAX_LENGTH}
              required={form.visibility === 'public'}
            />
          </div>
          {/* feat/risk-issue-4-section (2026-05-26): 4 セクション化 (issue/risk で type 別ラベル)
              共通設計: readOnly 時は MarkdownDisplay (= プレビュー固定)、編集時は MarkdownTextarea。
              labels は tField('issueOccurrence') vs tField('riskOccurrence') 等で出し分け。 */}
          {(() => {
            const labels = risk.type === 'risk'
              ? { occurrence: 'riskOccurrence', cause: 'riskCause', countermeasure: 'riskCountermeasure' }
              : { occurrence: 'issueOccurrence', cause: 'issueCause', countermeasure: 'issueCountermeasure' };
            const renderSection = (
              labelKey: string,
              value: string,
              prevValue: string,
              onChange: (v: string) => void,
              isOccurrence = false,
            ) => (
              <div className="space-y-2">
                <Label>
                  {tField(labelKey)}
                  {(!isOccurrence || form.visibility !== 'public') && (
                    <span className="ml-2 text-xs text-muted-foreground">{tRisk('optional')}</span>
                  )}
                </Label>
                {readOnly ? (
                  <div className="rounded-md border border-input bg-background px-3 py-2 text-sm">
                    <MarkdownDisplay value={value} />
                  </div>
                ) : (
                  <MarkdownTextarea
                    value={value}
                    onChange={onChange}
                    previousValue={prevValue}
                    rows={3}
                    maxLength={MEDIUM_TEXT_MAX_LENGTH}
                  />
                )}
              </div>
            );
            return (
              <>
                {renderSection(labels.occurrence, form.occurrence, risk.occurrence ?? '', (v) => setForm({ ...form, occurrence: v }), true)}
                {renderSection(labels.cause, form.cause, risk.cause ?? '', (v) => setForm({ ...form, cause: v }))}
                {renderSection(labels.countermeasure, form.responsePolicy, risk.responsePolicy ?? '', (v) => setForm({ ...form, responsePolicy: v }))}
                {renderSection('memo', form.content, risk.content, (v) => setForm({ ...form, content: v }))}
                {/* 2026-06-02: 結果を編集可能に追加 */}
                {renderSection('result', form.result, risk.result ?? '', (v) => setForm({ ...form, result: v }))}
              </>
            );
          })()}
          {/*
            PR-γ / 項目 5/6: type=issue では impact ラベルを「重要度」、likelihood ラベルを「緊急度」に。
            DB 列は同じ (impact / likelihood) のままで、UI label のみ type 別に出し分け。
            priority は API 側 computePriority() で自動算出される (UI から直接編集不可)。
          */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>{risk.type === 'issue' ? tField('importance') : tField('impact')}</Label>
              <select value={form.impact} onChange={(e) => setForm({ ...form, impact: e.target.value })} className={nativeSelectClass}>
                {Object.entries(IMPACT_LEVELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </div>
            <div className="space-y-2">
              <Label>{risk.type === 'issue' ? tField('urgency') : tField('likelihood')}</Label>
              <select value={form.likelihood} onChange={(e) => setForm({ ...form, likelihood: e.target.value })} className={nativeSelectClass}>
                {Object.entries(IMPACT_LEVELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>{tRisk('state')}</Label>
              <select value={form.state} onChange={(e) => setForm({ ...form, state: e.target.value })} className={nativeSelectClass}>
                {Object.entries(RISK_ISSUE_STATES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </div>
            <div className="space-y-2">
              <Label>{tField('assignee')}</Label>
              <select value={form.assigneeId} onChange={(e) => setForm({ ...form, assigneeId: e.target.value })} className={nativeSelectClass}>
                <option value="">{tRisk('notSet')}</option>
                {members.map((m) => <option key={m.userId} value={m.userId}>{m.userName}</option>)}
              </select>
            </div>
          </div>
          <div className="space-y-2">
            <Label>{tField('deadline')}</Label>
            <DateFieldWithActions value={form.deadline} onChange={(v) => setForm({ ...form, deadline: v })} />
          </div>
          </fieldset>
          {/* Phase E 共通化: DialogAttachmentSection に集約。readOnly 非表示は §5.14 由来 */}
          <DialogAttachmentSection
            entityType="risk"
            entityId={risk.id}
            readOnly={readOnly}
            mainLabel={tRisk('relatedUrl')}
          />
          {/* PR feat/asset-multi-linking-ui (Phase 2): 紐付け先プロジェクトを chip で表示 +
              現在のプロジェクトのみ「解除」可能 (他プロジェクトの解除は越境となるため非表示)。 */}
          {risk.linkedProjects && (
            <LinkedProjectsSection
              entityType={risk.type === 'issue' ? 'issue' : 'risk'}
              entityId={risk.id}
              linkedProjects={risk.linkedProjects}
              currentProjectId={currentProjectId ?? null}
              onChanged={onSaved}
            />
          )}
          {!readOnly && <Button type="submit" className="w-full">{t('save')}</Button>}
          {/* PR #199: コメント。fieldset disabled の外に配置することで readOnly でも投稿可。 */}
          <CommentSection
            entityType={risk.type === 'issue' ? 'issue' : 'risk'}
            entityId={risk.id}
            mutationsLocked={closedProject}
          />
        </form>
      </DialogContent>
    </Dialog>
  );
}
