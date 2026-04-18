'use client';

import { useState } from 'react';
import { useLoading } from '@/components/loading-overlay';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { nativeSelectClass } from '@/components/ui/native-select-style';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { PRIORITIES, RISK_ISSUE_STATES, VISIBILITIES, RISK_NATURES } from '@/types';

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
}: {
  risk: RiskLike | null;
  members: { userId: string; userName: string }[];
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSaved: () => Promise<void> | void;
}) {
  const { withLoading } = useLoading();
  const [form, setForm] = useState({
    title: '',
    content: '',
    impact: 'medium',
    likelihood: 'medium',
    priority: 'medium',
    state: 'open',
    assigneeId: '',
    deadline: '',
    visibility: 'draft',
    riskNature: 'threat',
  });
  const [error, setError] = useState('');
  // risk が切り替わったタイミングで form を同期するための prev 値追跡。
  // useEffect 内 setState は react-hooks/set-state-in-effect lint に抵触するため、
  // レンダー中に prev と比較して setState する「Derived State」パターンを採用
  // (React 公式が推奨する useEffect 不要パターン)。
  const [prevRiskId, setPrevRiskId] = useState<string | null>(risk?.id ?? null);
  if (risk && risk.id !== prevRiskId) {
    setPrevRiskId(risk.id);
    setForm({
      title: risk.title,
      content: risk.content,
      impact: risk.impact,
      likelihood: risk.likelihood ?? 'medium',
      priority: risk.priority,
      state: risk.state,
      assigneeId: risk.assigneeId ?? '',
      deadline: risk.deadline ?? '',
      visibility: risk.visibility,
      riskNature: risk.riskNature ?? 'threat',
    });
    setError('');
  }

  if (!risk) return null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!risk) return;
    setError('');
    const body: Record<string, unknown> = {
      title: form.title,
      content: form.content,
      impact: form.impact,
      priority: form.priority,
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
    await onSaved();
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{risk.type === 'risk' ? 'リスク編集' : '課題編集'}</DialogTitle>
          <DialogDescription>変更内容を保存します。</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          {error && <div className="rounded-md bg-red-50 p-3 text-sm text-red-600">{error}</div>}
          <div className="space-y-2">
            <Label>件名</Label>
            <Input
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              maxLength={100}
              required
            />
          </div>
          <div className="space-y-2">
            <Label>内容</Label>
            <textarea
              className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={form.content}
              onChange={(e) => setForm({ ...form, content: e.target.value })}
              rows={4}
              maxLength={2000}
              required
            />
          </div>
          <div className="grid grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label>影響度</Label>
              <select value={form.impact} onChange={(e) => setForm({ ...form, impact: e.target.value })} className={nativeSelectClass}>
                {Object.entries(PRIORITIES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </div>
            {risk.type === 'risk' && (
              <div className="space-y-2">
                <Label>発生可能性</Label>
                <select value={form.likelihood} onChange={(e) => setForm({ ...form, likelihood: e.target.value })} className={nativeSelectClass}>
                  {Object.entries(PRIORITIES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
              </div>
            )}
            <div className="space-y-2">
              <Label>優先度</Label>
              <select value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })} className={nativeSelectClass}>
                {Object.entries(PRIORITIES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>状態</Label>
              <select value={form.state} onChange={(e) => setForm({ ...form, state: e.target.value })} className={nativeSelectClass}>
                {Object.entries(RISK_ISSUE_STATES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </div>
            <div className="space-y-2">
              <Label>担当者</Label>
              <select value={form.assigneeId} onChange={(e) => setForm({ ...form, assigneeId: e.target.value })} className={nativeSelectClass}>
                <option value="">未設定</option>
                {members.map((m) => <option key={m.userId} value={m.userId}>{m.userName}</option>)}
              </select>
            </div>
          </div>
          <div className="space-y-2">
            <Label>期限</Label>
            <Input type="date" value={form.deadline} onChange={(e) => setForm({ ...form, deadline: e.target.value })} />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>公開範囲</Label>
              <select value={form.visibility} onChange={(e) => setForm({ ...form, visibility: e.target.value })} className={nativeSelectClass}>
                {Object.entries(VISIBILITIES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </div>
            {risk.type === 'risk' && (
              <div className="space-y-2">
                <Label>脅威 / 好機</Label>
                <select value={form.riskNature} onChange={(e) => setForm({ ...form, riskNature: e.target.value })} className={nativeSelectClass}>
                  {Object.entries(RISK_NATURES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
              </div>
            )}
          </div>
          <Button type="submit" className="w-full">保存</Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
