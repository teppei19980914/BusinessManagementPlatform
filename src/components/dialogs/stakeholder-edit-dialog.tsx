'use client';

/**
 * ステークホルダー作成 / 編集ダイアログ (PMBOK 13)。
 *
 * 役割:
 *   StakeholdersClient の「新規登録」ボタン (stakeholder=null) と行クリック (stakeholder=既存)
 *   の両方から呼ばれる兼用ダイアログ。stakeholder の有無で POST/PATCH を切り替える。
 *
 * 設計判断:
 *   - 影響度 / 関心度: 1-5 段階の native select (リスク/課題と同じ Tailwind ベース)
 *   - 内部メンバー紐付け: members prop からのプルダウンで userId をセット (任意)
 *   - tags: カンマ/読点 区切り入力 → parseTagsInput で正規化 (knowledge と同パターン)
 *   - 全画面トグル: feat/dialog-fullscreen-toggle の useDialogFullscreen を使う
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
// feat/markdown-textarea: Markdown 入力 + プレビュー + 既存値との差分表示
import { MarkdownTextarea } from '@/components/ui/markdown-textarea';
import { parseTagsInput } from '@/lib/parse-tags';
// PR #199: コメントセクション (新規作成時は entityId 未確定なので非表示)
import { CommentSection } from '@/components/comments/comment-section';
import {
  STAKEHOLDER_ATTITUDES,
  STAKEHOLDER_ENGAGEMENTS,
  STAKEHOLDER_LEVEL_MIN,
  STAKEHOLDER_LEVEL_MAX,
  type StakeholderAttitude,
  type StakeholderEngagement,
} from '@/config/master-data';
import type { StakeholderDTO } from '@/services/stakeholder.service';
import type { MemberDTO } from '@/services/member.service';

type FormState = {
  userId: string; // 空文字 = 外部 (null)
  name: string;
  organization: string;
  role: string;
  contactInfo: string;
  influence: number;
  interest: number;
  attitude: StakeholderAttitude;
  currentEngagement: StakeholderEngagement;
  desiredEngagement: StakeholderEngagement;
  personality: string;
  tagsInput: string;
  strategy: string;
};

const DEFAULT_FORM: FormState = {
  userId: '',
  name: '',
  organization: '',
  role: '',
  contactInfo: '',
  influence: 3,
  interest: 3,
  attitude: 'neutral',
  currentEngagement: 'neutral',
  desiredEngagement: 'supportive',
  personality: '',
  tagsInput: '',
  strategy: '',
};

const LEVELS: number[] = Array.from(
  { length: STAKEHOLDER_LEVEL_MAX - STAKEHOLDER_LEVEL_MIN + 1 },
  (_, i) => STAKEHOLDER_LEVEL_MIN + i,
);

export function StakeholderEditDialog({
  projectId,
  stakeholder,
  members,
  open,
  onOpenChange,
  onSaved,
}: {
  projectId: string;
  /** null = 新規作成、StakeholderDTO = 既存編集 */
  stakeholder: StakeholderDTO | null;
  /** 内部メンバー紐付け候補 (空配列でも動作: 紐付けなしの外部関係者として扱われる) */
  members: MemberDTO[];
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSaved: () => Promise<void> | void;
}) {
  const tAction = useTranslations('action');
  const t = useTranslations('stakeholder');
  const { withLoading } = useLoading();
  const { showSuccess, showError } = useToast();

  const [form, setForm] = useState<FormState>(DEFAULT_FORM);
  const [error, setError] = useState('');
  // 既存 stakeholder の id をトラックして、別レコードに切り替わったときに form を resync する
  // (PR #88 と同じ「dialog 開く度に DB データを初期表示」パターン)。
  const [prevId, setPrevId] = useState<string | null>(null);
  const currentId = stakeholder?.id ?? null;
  if (currentId !== prevId) {
    setPrevId(currentId);
    if (stakeholder) {
      setForm({
        userId: stakeholder.userId ?? '',
        name: stakeholder.name,
        organization: stakeholder.organization ?? '',
        role: stakeholder.role ?? '',
        contactInfo: stakeholder.contactInfo ?? '',
        influence: stakeholder.influence,
        interest: stakeholder.interest,
        attitude: stakeholder.attitude,
        currentEngagement: stakeholder.currentEngagement,
        desiredEngagement: stakeholder.desiredEngagement,
        personality: stakeholder.personality ?? '',
        tagsInput: (stakeholder.tags ?? []).join(', '),
        strategy: stakeholder.strategy ?? '',
      });
    } else {
      setForm(DEFAULT_FORM);
    }
    setError('');
  }

  const isEdit = stakeholder != null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');

    const payload = {
      userId: form.userId ? form.userId : null,
      name: form.name,
      organization: form.organization || null,
      role: form.role || null,
      contactInfo: form.contactInfo || null,
      influence: form.influence,
      interest: form.interest,
      attitude: form.attitude,
      currentEngagement: form.currentEngagement,
      desiredEngagement: form.desiredEngagement,
      personality: form.personality || null,
      tags: parseTagsInput(form.tagsInput),
      strategy: form.strategy || null,
    };

    const url = isEdit
      ? `/api/projects/${projectId}/stakeholders/${stakeholder!.id}`
      : `/api/projects/${projectId}/stakeholders`;
    const method = isEdit ? 'PATCH' : 'POST';

    const res = await withLoading(() =>
      fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }),
    );

    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      const msg = json.error?.message
        || json.error?.details?.[0]?.message
        || (isEdit ? t('updateFailed') : t('registerFailed'));
      setError(msg);
      showError(isEdit ? 'ステークホルダーの更新に失敗しました' : 'ステークホルダーの登録に失敗しました');
      return;
    }

    // feat/account-lock-and-ui-consistency: 即座に閉じてから reload を裏で走らせる
    onOpenChange(false);
    showSuccess(isEdit ? 'ステークホルダーを更新しました' : 'ステークホルダーを登録しました');
    void onSaved();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[min(90vw,42rem)] max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEdit ? t('editTitle') : t('createTitle')}</DialogTitle>
          <DialogDescription>
            {t('dialogDescription')}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>
          )}

          {/* 内部メンバー紐付け */}
          <div className="space-y-2">
            <Label>{t('internalMemberLink')}</Label>
            <select
              value={form.userId}
              onChange={(e) => {
                const v = e.target.value;
                // 内部メンバー選択時は氏名を自動補完 (空欄のときのみ)。
                const member = members.find((m) => m.userId === v);
                setForm({
                  ...form,
                  userId: v,
                  name: form.name || (member?.userName ?? ''),
                });
              }}
              className={nativeSelectClass}
            >
              <option value="">{t('externalParty')}</option>
              {members.map((m) => (
                <option key={m.userId} value={m.userId}>{m.userName}</option>
              ))}
            </select>
          </div>

          {/* 氏名 / 所属 / 役職 */}
          <div className="space-y-2">
            <Label>{t('fieldName')}</Label>
            <Input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              maxLength={100}
              required
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>{t('fieldOrganization')}</Label>
              <Input
                value={form.organization}
                onChange={(e) => setForm({ ...form, organization: e.target.value })}
                maxLength={100}
              />
            </div>
            <div className="space-y-2">
              <Label>{t('fieldRole')}</Label>
              <Input
                value={form.role}
                onChange={(e) => setForm({ ...form, role: e.target.value })}
                maxLength={100}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label>{t('fieldContactInfo')}</Label>
            <MarkdownTextarea
              value={form.contactInfo}
              onChange={(v) => setForm({ ...form, contactInfo: v })}
              previousValue={isEdit ? (stakeholder?.contactInfo ?? '') : undefined}
              rows={2}
              maxLength={1000}
            />
          </div>

          {/* Power/Interest grid */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>{t('fieldInfluence')}</Label>
              <select
                value={form.influence}
                onChange={(e) => setForm({ ...form, influence: Number(e.target.value) })}
                className={nativeSelectClass}
              >
                {LEVELS.map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <Label>{t('fieldInterest')}</Label>
              <select
                value={form.interest}
                onChange={(e) => setForm({ ...form, interest: Number(e.target.value) })}
                className={nativeSelectClass}
              >
                {LEVELS.map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            </div>
          </div>

          {/* 姿勢 */}
          <div className="space-y-2">
            <Label>{t('fieldAttitude')}</Label>
            <select
              value={form.attitude}
              onChange={(e) => setForm({ ...form, attitude: e.target.value as StakeholderAttitude })}
              className={nativeSelectClass}
            >
              {Object.entries(STAKEHOLDER_ATTITUDES).map(([k, l]) => (
                <option key={k} value={k}>{l}</option>
              ))}
            </select>
          </div>

          {/* Engagement Gap */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>{t('fieldCurrentEngagement')}</Label>
              <select
                value={form.currentEngagement}
                onChange={(e) =>
                  setForm({ ...form, currentEngagement: e.target.value as StakeholderEngagement })
                }
                className={nativeSelectClass}
              >
                {Object.entries(STAKEHOLDER_ENGAGEMENTS).map(([k, l]) => (
                  <option key={k} value={k}>{l}</option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <Label>{t('fieldDesiredEngagement')}</Label>
              <select
                value={form.desiredEngagement}
                onChange={(e) =>
                  setForm({ ...form, desiredEngagement: e.target.value as StakeholderEngagement })
                }
                className={nativeSelectClass}
              >
                {Object.entries(STAKEHOLDER_ENGAGEMENTS).map(([k, l]) => (
                  <option key={k} value={k}>{l}</option>
                ))}
              </select>
            </div>
          </div>

          {/* 人となり / タグ / 対応戦略 */}
          <div className="space-y-2">
            <Label>{t('fieldPersonality')}</Label>
            <MarkdownTextarea
              value={form.personality}
              onChange={(v) => setForm({ ...form, personality: v })}
              previousValue={isEdit ? (stakeholder?.personality ?? '') : undefined}
              rows={4}
              maxLength={2000}
              placeholder={t('personalityPlaceholder')}
            />
          </div>

          {/* Phase A 要件 10: ステークホルダーのタグ入力 UI 削除 (設定の必要性なし)。
              内部 form.tagsInput は API 互換のため空文字で残置 (将来再有効化 or T-XX で完全削除可)。 */}

          <div className="space-y-2">
            <Label>{t('fieldStrategy')}</Label>
            <MarkdownTextarea
              value={form.strategy}
              onChange={(v) => setForm({ ...form, strategy: v })}
              previousValue={isEdit ? (stakeholder?.strategy ?? '') : undefined}
              rows={3}
              maxLength={2000}
              placeholder={t('strategyPlaceholder')}
            />
          </div>

          <Button type="submit" className="w-full">{isEdit ? tAction('save') : t('submitRegister')}</Button>
          {/* PR #199: コメント。新規作成時は entityId 未確定なので非表示。 */}
          {isEdit && stakeholder && (
            <CommentSection entityType="stakeholder" entityId={stakeholder.id} />
          )}
        </form>
      </DialogContent>
    </Dialog>
  );
}
