'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useLoading } from '@/components/loading-overlay';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';
import { nativeSelectClass } from '@/components/ui/native-select-style';
import { RiskEditDialog } from '@/components/dialogs/risk-edit-dialog';
import { PRIORITIES, RISK_ISSUE_STATES, VISIBILITIES, RISK_NATURES } from '@/types';
import type { RiskDTO } from '@/services/risk.service';
import type { MemberDTO } from '@/services/member.service';

type Props = {
  projectId: string;
  risks: RiskDTO[];
  members: MemberDTO[];
  canEdit: boolean;
  canCreate: boolean;
  systemRole: string;
  /** PR #60 #1: 'risk' / 'issue' どちらか固定で表示 (未指定なら従来通り両方) */
  typeFilter?: 'risk' | 'issue';
  /** CRUD 後に呼び出す再取得ハンドラ（未指定時は router.refresh フォールバック）*/
  onReload?: () => Promise<void> | void;
};

const impactColors: Record<string, 'default' | 'secondary' | 'destructive'> = {
  high: 'destructive',
  medium: 'default',
  low: 'secondary',
};

export function RisksClient({ projectId, risks, members, canCreate, systemRole, typeFilter, onReload }: Props) {
  const router = useRouter();
  const { withLoading } = useLoading();
  const reload = useCallback(async () => {
    if (onReload) {
      await onReload();
    } else {
      router.refresh();
    }
  }, [onReload, router]);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [error, setError] = useState('');
  // 行クリックで開く編集ダイアログの対象 (null = 閉じる)
  const [editingRisk, setEditingRisk] = useState<RiskDTO | null>(null);
  const initialType = typeFilter ?? 'risk';
  const [form, setForm] = useState({
    type: initialType,
    title: '',
    content: '',
    impact: 'medium',
    likelihood: 'medium',
    // PR #63: 優先度は UI から撤去 (将来 impact × likelihood から自動算出予定)
    assigneeId: '',
    visibility: 'draft',
    riskNature: 'threat',
  });
  const filteredRisks = typeFilter ? risks.filter((r) => r.type === typeFilter) : risks;
  const headingLabel = typeFilter === 'issue' ? '課題管理' : typeFilter === 'risk' ? 'リスク管理' : 'リスク / 課題管理';
  const createLabel = typeFilter === 'issue' ? '課題起票' : typeFilter === 'risk' ? 'リスク起票' : '起票';

  // PR #65 Phase 2 (c): 起票中に類似する過去課題 (他プロジェクト) を inline でサジェスト。
  // 未然対応の気付きを起票中のユーザに与え、抜け漏れゼロ化を促す。
  type RelatedIssue = {
    id: string;
    title: string;
    snippet: string;
    sourceProjectId: string;
    sourceProjectName: string | null;
    score: number;
  };
  const [relatedIssues, setRelatedIssues] = useState<RelatedIssue[]>([]);
  // debounce 用のタイマー ref (再入力のたびに前のタイマーをクリア)
  const suggestTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 外部 API (サジェスト) との同期であり react-hooks/set-state-in-effect の
  // 例外に該当 (DESIGN.md §22 と use-session-state と同等の扱い)。
  useEffect(() => {
    // ダイアログが閉じているときは走らせない
    if (!isCreateOpen) return;
    // 文字数が少なすぎる間はノイズが多いので問い合わせない
    const combined = `${form.title} ${form.content}`.trim();
    if (combined.length < 10) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setRelatedIssues([]);
      return;
    }
    // 前回の pending タイマーをキャンセル
    if (suggestTimerRef.current) clearTimeout(suggestTimerRef.current);
    suggestTimerRef.current = setTimeout(() => {
      void (async () => {
        try {
          const res = await fetch(
            `/api/projects/${projectId}/suggestions/related-issues`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ text: combined }),
            },
          );
          if (!res.ok) return;
          const json = await res.json();
          setRelatedIssues(json.data ?? []);
        } catch {
          // ネットワーク失敗時は inline 提案なし (起票本線に影響させない)
        }
      })();
    }, 500);
    return () => {
      if (suggestTimerRef.current) clearTimeout(suggestTimerRef.current);
    };
  }, [form.title, form.content, isCreateOpen, projectId]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    const body = {
      ...form,
      assigneeId: form.assigneeId || undefined,
      likelihood: form.type === 'risk' ? form.likelihood : undefined,
      riskNature: form.type === 'risk' ? form.riskNature : undefined,
    };
    const res = await withLoading(() =>
      fetch(`/api/projects/${projectId}/risks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
    if (!res.ok) {
      const json = await res.json();
      setError(json.error?.message || json.error?.details?.[0]?.message || '作成に失敗しました');
      return;
    }
    setIsCreateOpen(false);
    setForm({
      type: initialType,
      title: '',
      content: '',
      impact: 'medium',
      likelihood: 'medium',
      assigneeId: '',
      visibility: 'draft',
      riskNature: 'threat',
    });
    await reload();
  }

  async function handleExport() {
    window.open(`/api/projects/${projectId}/risks/export`, '_blank');
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">{headingLabel}</h2>
        <div className="flex gap-2">
          {systemRole === 'admin' && (
            <Button variant="outline" onClick={handleExport}>CSV出力</Button>
          )}
          {canCreate && (
            <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
              <DialogTrigger className="inline-flex shrink-0 items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-xs hover:bg-primary/90">{createLabel}</DialogTrigger>
              <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
                <DialogHeader>
                  <DialogTitle>{createLabel}</DialogTitle>
                  <DialogDescription>
                    {typeFilter === 'issue' ? '課題を登録してください。' : typeFilter === 'risk' ? 'リスクを登録してください。' : 'リスクまたは課題を登録してください。'}
                  </DialogDescription>
                </DialogHeader>
                <form onSubmit={handleCreate} className="space-y-4">
                  {error && <div className="rounded-md bg-red-50 p-3 text-sm text-red-600">{error}</div>}
                  {/* PR #63: 公開範囲 / 脅威・好機 を最上位に配置 (設定忘れ防止の視線誘導) */}
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label>公開範囲</Label>
                      <select value={form.visibility} onChange={(e) => setForm({ ...form, visibility: e.target.value })} className={nativeSelectClass}>
                        {Object.entries(VISIBILITIES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                      </select>
                    </div>
                    {form.type === 'risk' && (
                      <div className="space-y-2">
                        <Label>脅威 / 好機</Label>
                        <select value={form.riskNature} onChange={(e) => setForm({ ...form, riskNature: e.target.value })} className={nativeSelectClass}>
                          {Object.entries(RISK_NATURES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                        </select>
                      </div>
                    )}
                  </div>
                  {!typeFilter && (
                    <div className="space-y-2">
                      <Label>種別</Label>
                      <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as 'risk' | 'issue' })} className={nativeSelectClass}>
                        <option value="risk">リスク</option>
                        <option value="issue">課題</option>
                      </select>
                    </div>
                  )}
                  <div className="space-y-2">
                    <Label>件名</Label>
                    <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} maxLength={100} required />
                  </div>
                  <div className="space-y-2">
                    <Label>内容</Label>
                    <textarea className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={form.content} onChange={(e) => setForm({ ...form, content: e.target.value })} rows={4} maxLength={2000} required />
                  </div>
                  {/*
                    PR #65 Phase 2 (c): 入力中に類似する過去課題を inline 提示。
                    似た事象が過去に発生しているなら、ここで気付かせて未然対応に繋げる。
                  */}
                  {relatedIssues.length > 0 && (
                    <div className="rounded-md border border-amber-300 bg-amber-50 p-3 space-y-2">
                      <p className="text-xs font-semibold text-amber-900">
                        類似する過去課題があります ({relatedIssues.length} 件)
                        <span className="ml-1 font-normal">
                          - 過去に発生した事象の再来かもしれません、念のためご確認ください
                        </span>
                      </p>
                      <ul className="space-y-1">
                        {relatedIssues.map((r) => (
                          <li key={r.id} className="text-sm">
                            <div className="flex items-center gap-2">
                              <span className="font-medium">{r.title}</span>
                              <Badge variant="outline" className="text-xs">類似度 {(r.score * 100).toFixed(0)}%</Badge>
                              {r.sourceProjectName && (
                                <Link
                                  href={`/projects/${r.sourceProjectId}/issues`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-xs text-blue-600 hover:underline"
                                >
                                  出典: {r.sourceProjectName}
                                </Link>
                              )}
                            </div>
                            <p className="text-xs text-gray-700">{r.snippet}</p>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {/* PR #63: 優先度は UI から撤去 (将来 impact × likelihood で自動算出予定) */}
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label>影響度</Label>
                      <select value={form.impact} onChange={(e) => setForm({ ...form, impact: e.target.value })} className={nativeSelectClass}>
                        {Object.entries(PRIORITIES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                      </select>
                    </div>
                    {form.type === 'risk' && (
                      <div className="space-y-2">
                        <Label>発生可能性</Label>
                        <select value={form.likelihood} onChange={(e) => setForm({ ...form, likelihood: e.target.value })} className={nativeSelectClass}>
                          {Object.entries(PRIORITIES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                        </select>
                      </div>
                    )}
                  </div>
                  <div className="space-y-2">
                    <Label>担当者</Label>
                    <select value={form.assigneeId} onChange={(e) => setForm({ ...form, assigneeId: e.target.value })} className={nativeSelectClass}>
                      <option value="">未設定</option>
                      {members.map((m) => <option key={m.userId} value={m.userId}>{m.userName}</option>)}
                    </select>
                  </div>
                  <Button type="submit" className="w-full">{createLabel}</Button>
                </form>
              </DialogContent>
            </Dialog>
          )}
        </div>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            {!typeFilter && <TableHead>種別</TableHead>}
            <TableHead>件名</TableHead>
            <TableHead>影響度</TableHead>
            <TableHead>優先度</TableHead>
            <TableHead>状態</TableHead>
            <TableHead>担当者</TableHead>
            <TableHead>起票日</TableHead>
            {canCreate && <TableHead>操作</TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {filteredRisks.map((r) => (
            <TableRow
              key={r.id}
              // Req 8: 行クリックで編集ダイアログを開く (canCreate = メンバー以上)
              className={canCreate ? 'cursor-pointer hover:bg-gray-50' : ''}
              onClick={canCreate ? () => setEditingRisk(r) : undefined}
            >
              {!typeFilter && <TableCell><Badge variant="outline">{r.type === 'risk' ? 'リスク' : '課題'}</Badge></TableCell>}
              <TableCell className="font-medium">{r.title}</TableCell>
              <TableCell><Badge variant={impactColors[r.impact] || 'secondary'}>{PRIORITIES[r.impact as keyof typeof PRIORITIES]}</Badge></TableCell>
              <TableCell><Badge variant={impactColors[r.priority] || 'secondary'}>{PRIORITIES[r.priority as keyof typeof PRIORITIES]}</Badge></TableCell>
              <TableCell>
                {/*
                  PR #59: 状態列はインライン編集を廃止し、他列同様に読み取り専用バッジ表示。
                  変更は行クリック → RiskEditDialog 内の「状態」選択経由に統一する。
                */}
                <Badge variant="outline">
                  {RISK_ISSUE_STATES[r.state as keyof typeof RISK_ISSUE_STATES] || r.state}
                </Badge>
              </TableCell>
              <TableCell>{r.assigneeName || '-'}</TableCell>
              <TableCell>{new Date(r.createdAt).toLocaleDateString('ja-JP')}</TableCell>
              {canCreate && (
                <TableCell onClick={(e) => e.stopPropagation()}>
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-red-600"
                    onClick={async () => {
                      if (!confirm('このリスク/課題を削除しますか？')) return;
                      await withLoading(() =>
                        fetch(`/api/projects/${projectId}/risks/${r.id}`, { method: 'DELETE' }),
                      );
                      await reload();
                    }}
                  >
                    削除
                  </Button>
                </TableCell>
              )}
            </TableRow>
          ))}
          {filteredRisks.length === 0 && (
            <TableRow>
              <TableCell colSpan={(canCreate ? 7 : 6) + (typeFilter ? 0 : 1)} className="py-8 text-center text-gray-500">
                {typeFilter === 'issue' ? '課題がありません' : typeFilter === 'risk' ? 'リスクがありません' : 'リスク / 課題がありません'}
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>

      <RiskEditDialog
        risk={editingRisk}
        members={members}
        open={editingRisk != null}
        onOpenChange={(v) => { if (!v) setEditingRisk(null); }}
        onSaved={reload}
      />
    </div>
  );
}
