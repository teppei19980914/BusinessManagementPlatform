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
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { nativeSelectClass } from '@/components/ui/native-select-style';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { parseTagsInput } from '@/lib/parse-tags';
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
  const t = useTranslations('action');
  const { withLoading } = useLoading();

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
      setError(
        json.error?.message
          || json.error?.details?.[0]?.message
          || (isEdit ? '更新に失敗しました' : '登録に失敗しました'),
      );
      return;
    }

    // feat/account-lock-and-ui-consistency: 即座に閉じてから reload を裏で走らせる
    onOpenChange(false);
    void onSaved();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[min(90vw,42rem)] max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'ステークホルダー編集' : 'ステークホルダー新規登録'}</DialogTitle>
          <DialogDescription>
            PMBOK 13 準拠: 影響度 / 関心度 / 姿勢 / エンゲージメント水準を記録し、対応戦略を整理します。
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>
          )}

          {/* 内部メンバー紐付け */}
          <div className="space-y-2">
            <Label>内部メンバー紐付け</Label>
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
              <option value="">外部関係者 (内部紐付けなし)</option>
              {members.map((m) => (
                <option key={m.userId} value={m.userId}>{m.userName}</option>
              ))}
            </select>
          </div>

          {/* 氏名 / 所属 / 役職 */}
          <div className="space-y-2">
            <Label>氏名</Label>
            <Input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              maxLength={100}
              required
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>所属組織</Label>
              <Input
                value={form.organization}
                onChange={(e) => setForm({ ...form, organization: e.target.value })}
                maxLength={100}
              />
            </div>
            <div className="space-y-2">
              <Label>役職</Label>
              <Input
                value={form.role}
                onChange={(e) => setForm({ ...form, role: e.target.value })}
                maxLength={100}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label>連絡先メモ</Label>
            <textarea
              className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={form.contactInfo}
              onChange={(e) => setForm({ ...form, contactInfo: e.target.value })}
              rows={2}
              maxLength={1000}
            />
          </div>

          {/* Power/Interest grid */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>影響度 (1-5)</Label>
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
              <Label>関心度 (1-5)</Label>
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
            <Label>姿勢</Label>
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
              <Label>現在のエンゲージメント</Label>
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
              <Label>望ましいエンゲージメント</Label>
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
            <Label>人となり / 考え方 (自由記述)</Label>
            <textarea
              className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={form.personality}
              onChange={(e) => setForm({ ...form, personality: e.target.value })}
              rows={4}
              maxLength={2000}
              placeholder="例: 数字で語ると納得しやすい / 議論より資料を読む派 / 決裁前に必ず Slack で根回し"
            />
          </div>

          <div className="space-y-2">
            <Label>タグ (カンマ / 読点区切り)</Label>
            <Input
              value={form.tagsInput}
              onChange={(e) => setForm({ ...form, tagsInput: e.target.value })}
              placeholder="例: 技術志向, 数字派, 早朝型"
              maxLength={200}
            />
          </div>

          <div className="space-y-2">
            <Label>対応戦略 (具体的アクション)</Label>
            <textarea
              className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={form.strategy}
              onChange={(e) => setForm({ ...form, strategy: e.target.value })}
              rows={3}
              maxLength={2000}
              placeholder="例: 月 1 で 30 分の 1on1 / 月次レポートに KPI サマリ添付 / 重要意思決定は事前に Slack で打診"
            />
          </div>

          <Button type="submit" className="w-full">{isEdit ? t('save') : '登録'}</Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
