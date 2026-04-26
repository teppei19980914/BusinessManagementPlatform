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
import { PRIORITIES, RISK_ISSUE_STATES, VISIBILITIES, RISK_NATURES } from '@/types';
import { NAME_MAX_LENGTH, MEDIUM_TEXT_MAX_LENGTH } from '@/config';
import { AttachmentList } from '@/components/attachments/attachment-list';
import { DateFieldWithActions } from '@/components/ui/date-field-with-actions';
// feat/dialog-fullscreen-toggle: 文字量が多い編集 dialog 向けの全画面トグル
import { useDialogFullscreen } from '@/components/ui/use-dialog-fullscreen';

/**
 * リスク/課題の編集に必要な最小限の形状。RiskDTO / AllRiskDTO 両方と互換。
 */
type RiskLike = {
  id: string;
  projectId: string;
  type: string;
  title: string;
  content: string;
  impact: string;
  likelihood: string | null;
  priority: string;
  state: string;
  assigneeId: string | null;
  deadline: string | null;
  visibility: string;
  riskNature: string | null;
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
}: {
  risk: RiskLike | null;
  members: { userId: string; userName: string }[];
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSaved: () => Promise<void> | void;
  /** PR #61: 非公開プロジェクトの行クリック時など、参照専用で開く場合に true */
  readOnly?: boolean;
}) {
  const t = useTranslations('action');
  const tField = useTranslations('field');
  const { withLoading } = useLoading();
  // feat/dialog-fullscreen-toggle: 全画面トグル (90vw × 90vh)。state は dialog ローカル。
  const { fullscreenClassName, FullscreenToggle } = useDialogFullscreen();
  const [form, setForm] = useState({
    title: '',
    content: '',
    impact: 'medium',
    likelihood: 'medium',
    // PR #63: 優先度は UI から撤去 (将来 impact × likelihood で自動算出予定)
    state: 'open',
    assigneeId: '',
    deadline: '',
    visibility: 'draft',
    riskNature: 'threat',
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
      content: risk.content,
      impact: risk.impact,
      likelihood: risk.likelihood ?? 'medium',
      state: risk.state,
      assigneeId: risk.assigneeId ?? '',
      deadline: risk.deadline ?? '',
      visibility: risk.visibility,
      riskNature: risk.riskNature ?? 'threat',
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
    const body: Record<string, unknown> = {
      title: form.title,
      content: form.content,
      impact: form.impact,
      state: form.state,
      assigneeId: form.assigneeId || null,
      deadline: form.deadline || null,
      visibility: form.visibility,
    };
    if (risk.type === 'risk') {
      body.likelihood = form.likelihood;
      body.riskNature = form.riskNature;
    }

    const res = await withLoading(() =>
      fetch(`/api/projects/${risk.projectId}/risks/${risk.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      setError(json.error?.message || json.error?.details?.[0]?.message || '更新に失敗しました');
      return;
    }
    // feat/account-lock-and-ui-consistency: 作成 dialog と挙動を揃える。
    // 旧実装: await onSaved() → onOpenChange(false) — reload 完了を待つため遅く感じる
    // 新実装: onOpenChange(false) → onSaved() (fire-and-forget) — 即座に閉じて裏で reload
    onOpenChange(false);
    void onSaved();
  }

  const titleText = risk.type === 'risk' ? 'リスク' : '課題';
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={`max-w-[min(90vw,36rem)] max-h-[80vh] overflow-y-auto ${fullscreenClassName}`}>
        <DialogHeader>
          <div className="flex items-center justify-between gap-2">
            <DialogTitle>{readOnly ? `${titleText}詳細` : `${titleText}編集`}</DialogTitle>
            <FullscreenToggle />
          </div>
          <DialogDescription>
            {readOnly ? '参照専用です (プロジェクト非メンバーのため編集不可)。' : '変更内容を保存します。'}
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
            <Label>{tField('title')}</Label>
            <Input
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              maxLength={NAME_MAX_LENGTH}
              required
            />
          </div>
          <div className="space-y-2">
            <Label>{tField('content')}</Label>
            <textarea
              className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={form.content}
              onChange={(e) => setForm({ ...form, content: e.target.value })}
              rows={4}
              maxLength={MEDIUM_TEXT_MAX_LENGTH}
              required
            />
          </div>
          {/* PR #63: 優先度は UI から撤去 (将来 impact × likelihood で自動算出予定) */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>{tField('impact')}</Label>
              <select value={form.impact} onChange={(e) => setForm({ ...form, impact: e.target.value })} className={nativeSelectClass}>
                {Object.entries(PRIORITIES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </div>
            {risk.type === 'risk' && (
              <div className="space-y-2">
                <Label>{tField('likelihood')}</Label>
                <select value={form.likelihood} onChange={(e) => setForm({ ...form, likelihood: e.target.value })} className={nativeSelectClass}>
                  {Object.entries(PRIORITIES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
              </div>
            )}
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>状態</Label>
              <select value={form.state} onChange={(e) => setForm({ ...form, state: e.target.value })} className={nativeSelectClass}>
                {Object.entries(RISK_ISSUE_STATES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </div>
            <div className="space-y-2">
              <Label>{tField('assignee')}</Label>
              <select value={form.assigneeId} onChange={(e) => setForm({ ...form, assigneeId: e.target.value })} className={nativeSelectClass}>
                <option value="">未設定</option>
                {members.map((m) => <option key={m.userId} value={m.userId}>{m.userName}</option>)}
              </select>
            </div>
          </div>
          <div className="space-y-2">
            <Label>{tField('deadline')}</Label>
            <DateFieldWithActions value={form.deadline} onChange={(v) => setForm({ ...form, deadline: v })} />
          </div>
          </fieldset>
          {/* PR #64 Phase 2: 関連 URL (エビデンス・証跡・関連チケット等)。
              fix/attachment-list-non-member-403: readOnly モード (= 全リスク/全課題等の
              横断ビューから開いた場合) は非メンバーが多数を占めるため、添付 fetch を行うと
              `/api/attachments?entityType=risk&...` が 403 を返してブラウザ Console に
              エラーが出力される (§5.10 エラー情報最小化方針違反)。読み取り権限緩和は
              future work、現状は readOnly 時に AttachmentList 自体を非表示にする。
              プロジェクト個別画面 (readOnly=false 経路) では従来通り表示・編集可。 */}
          {!readOnly && (
            <AttachmentList
              entityType="risk"
              entityId={risk.id}
              canEdit
              label="関連 URL"
            />
          )}
          {!readOnly && <Button type="submit" className="w-full">{t('save')}</Button>}
        </form>
      </DialogContent>
    </Dialog>
  );
}
