'use client';

/**
 * リスク/課題画面 (プロジェクト詳細タブ配下) のクライアントコンポーネント。
 *
 * 役割:
 *   リスク (type='risk') と課題 (type='issue') を統合タブで管理する。
 *   - 一覧表示 (フィルタ: 状態 / 優先度 / 担当者 / 公開範囲)
 *   - 新規起票ダイアログ (RiskEditDialog)
 *   - 行クリックで編集ダイアログ (PR #56 Req 8/9)
 *   - CSV エクスポートボタン
 *
 * 公開範囲制御:
 *   visibility='draft' は作成者本人 + admin のみ閲覧可、'public' は全ログインユーザ可。
 *   サービス層で WHERE フィルタ済のため、UI 側は受信データをそのまま表示する。
 *
 * 認可: canEdit prop (PM/TL 以上 or admin) で起票/編集ボタンの表示制御。
 * API: /api/projects/[id]/risks (GET/POST), /api/projects/[id]/risks/[riskId] (PATCH/DELETE)
 *
 * 関連:
 *   - SPECIFICATION.md (リスク・課題管理)
 *   - DESIGN.md §5 (テーブル定義: risks_issues)
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useLoading } from '@/components/loading-overlay';
import { Button } from '@/components/ui/button';
import { EntitySyncImportDialog } from '@/components/dialogs/entity-sync-import-dialog';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Table, TableBody, TableCell, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  ResizableColumnsProvider,
  ResizableHead,
  ResetColumnsButton,
} from '@/components/ui/resizable-columns';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';
import { nativeSelectClass } from '@/components/ui/native-select-style';
import { DateFieldWithActions } from '@/components/ui/date-field-with-actions';
import { RiskEditDialog } from '@/components/dialogs/risk-edit-dialog';
import {
  StagedAttachmentsInput,
  persistStagedAttachments,
  type StagedAttachment,
} from '@/components/attachments/staged-attachments-input';
import { useBatchAttachments } from '@/components/attachments/use-batch-attachments';
import { AttachmentsCell } from '@/components/attachments/attachments-cell';
import { PRIORITIES, IMPACT_LEVELS, RISK_ISSUE_STATES, VISIBILITIES, RISK_NATURES } from '@/types';
import type { RiskDTO } from '@/services/risk.service';
import type { MemberDTO } from '@/services/member.service';
// PR #117 → PR #119: session 連携フォーマッタ
import { useFormatters } from '@/lib/use-formatters';
// feat/dialog-fullscreen-toggle: 文字量が多い dialog 向けの全画面トグル
import { useDialogFullscreen } from '@/components/ui/use-dialog-fullscreen';
// feat/markdown-textarea: Markdown 入力 + プレビュー (create dialog なので previousValue なし)
import { MarkdownTextarea } from '@/components/ui/markdown-textarea';

type Props = {
  projectId: string;
  risks: RiskDTO[];
  members: MemberDTO[];
  /** 2026-04-24: 起票ボタンの表示可否 (実際の ProjectMember の pm_tl/member のみ true) */
  canCreate: boolean;
  /** 2026-04-24: 作成者本人判定に使用 (reporterId === currentUserId で編集/削除許可) */
  currentUserId: string;
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

export function RisksClient({ projectId, risks, members, canCreate, currentUserId, systemRole, typeFilter, onReload }: Props) {
  const router = useRouter();
  const tRisk = useTranslations('risk');
  const tAction = useTranslations('action');
  const tField = useTranslations('field');
  const { withLoading } = useLoading();
  // PR #119: session 連携フォーマッタ
  const { formatDate } = useFormatters();
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
  // feat/dialog-fullscreen-toggle: 起票 dialog の全画面トグル (90vw × 90vh)
  const { fullscreenClassName: createFsClassName, FullscreenToggle: CreateFullscreenToggle } = useDialogFullscreen();
  const initialType = typeFilter ?? 'risk';
  const [form, setForm] = useState({
    type: initialType,
    title: '',
    content: '',
    impact: 'medium',
    likelihood: 'medium',
    // PR #63: 優先度は UI から撤去 (将来 impact × likelihood から自動算出予定)
    // fix/quick-ux item 8: デフォルト担当者=自分 (起票者本人)。プルダウンで変更可。
    assigneeId: currentUserId,
    visibility: 'draft',
    riskNature: 'threat',
  });
  // PR #165: プロジェクト「リスク/課題一覧」での一括更新機能 (旧 cross-list 版から移し替え)
  // フィルター適用時のみ checkbox 列とツールバーが現れ、作成者本人の行のみ選択可。
  // 「フィルター必須」を UI + API 両方で強制する二重防御 (DEVELOPER_GUIDE §5.21)。
  // PR-γ / 項目 4 + 9: フィルタは impact (影響度/重要度) ではなく priority (優先度) で行う。
  // 一覧表示も priority のみで、最終判断は priority で行うため。
  const [bulkFilter, setBulkFilter] = useState<{
    state: string; // '' = 未指定
    priority: string;
    keyword: string;
    mineOnly: boolean;
  }>({ state: '', priority: '', keyword: '', mineOnly: false });
  const filterApplied = Boolean(
    bulkFilter.state || bulkFilter.priority || bulkFilter.mineOnly
    || (bulkFilter.keyword && bulkFilter.keyword.trim().length > 0)
    || typeFilter, // typeFilter (risk/issue タブ) は暗黙のフィルター
  );

  const filteredRisks = useMemo(() => {
    let xs = typeFilter ? risks.filter((r) => r.type === typeFilter) : risks;
    if (bulkFilter.state) xs = xs.filter((r) => r.state === bulkFilter.state);
    if (bulkFilter.priority) xs = xs.filter((r) => r.priority === bulkFilter.priority);
    if (bulkFilter.mineOnly) xs = xs.filter((r) => r.viewerIsCreator === true);
    if (bulkFilter.keyword.trim()) {
      const kw = bulkFilter.keyword.trim().toLowerCase();
      xs = xs.filter((r) => r.title.toLowerCase().includes(kw) || r.content.toLowerCase().includes(kw));
    }
    return xs;
  }, [risks, typeFilter, bulkFilter]);
  const headingLabel = typeFilter === 'issue' ? tRisk('headingIssue') : typeFilter === 'risk' ? tRisk('headingRisk') : tRisk('headingBoth');
  const createLabel = typeFilter === 'issue' ? tRisk('createIssue') : typeFilter === 'risk' ? tRisk('createRisk') : tRisk('createBoth');

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

  // PR #67: 起票時にステージする添付 URL
  const [stagedCreateAttachments, setStagedCreateAttachments] = useState<StagedAttachment[]>([]);

  // PR #67: 一覧添付列用のバッチ取得
  const attachmentsByEntity = useBatchAttachments(
    'risk',
    filteredRisks.map((r) => r.id),
  );

  // PR #165: 一括選択 + 一括編集ダイアログ
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const selectableIds = filterApplied
    ? filteredRisks.filter((r) => r.viewerIsCreator === true).map((r) => r.id)
    : [];
  const allSelectableSelected
    = selectableIds.length > 0 && selectableIds.every((id) => selectedIds.has(id));

  function toggleOneId(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleAllIds() {
    setSelectedIds(allSelectableSelected ? new Set() : new Set(selectableIds));
  }

  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkApply, setBulkApply] = useState({ state: false, assigneeId: false, deadline: false });
  const [bulkValues, setBulkValues] = useState({ state: 'open', assigneeId: '', deadline: '' });
  const [bulkAssigneeClear, setBulkAssigneeClear] = useState(false);
  const [bulkDeadlineClear, setBulkDeadlineClear] = useState(false);
  const [bulkError, setBulkError] = useState('');

  function openBulk() {
    setBulkApply({ state: false, assigneeId: false, deadline: false });
    setBulkValues({ state: 'open', assigneeId: '', deadline: '' });
    setBulkAssigneeClear(false);
    setBulkDeadlineClear(false);
    setBulkError('');
    setBulkOpen(true);
  }

  async function submitBulk() {
    setBulkError('');
    const patch: Record<string, string | null | undefined> = {};
    if (bulkApply.state) patch.state = bulkValues.state;
    if (bulkApply.assigneeId) patch.assigneeId = bulkAssigneeClear ? null : (bulkValues.assigneeId || null);
    if (bulkApply.deadline) patch.deadline = bulkDeadlineClear ? null : (bulkValues.deadline || null);
    if (Object.keys(patch).length === 0) {
      setBulkError(tRisk('bulkUpdateRequireOne'));
      return;
    }
    const res = await withLoading(() =>
      fetch(`/api/projects/${projectId}/risks/bulk`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ids: Array.from(selectedIds),
          filterFingerprint: {
            type: typeFilter,
            state: bulkFilter.state || undefined,
            priority: bulkFilter.priority || undefined,
            mineOnly: bulkFilter.mineOnly || undefined,
            keyword: bulkFilter.keyword.trim() || undefined,
          },
          patch,
        }),
      }),
    );
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setBulkError(j?.message || j?.error || tRisk('bulkUpdateFailed'));
      return;
    }
    setBulkOpen(false);
    setSelectedIds(new Set());
    await reload();
  }

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
      setError(json.error?.message || json.error?.details?.[0]?.message || tRisk('createFailed'));
      return;
    }
    // PR #67: 作成成功直後にステージされた添付を一括 POST
    const json = await res.json();
    if (stagedCreateAttachments.length > 0 && json.data?.id) {
      await persistStagedAttachments({
        entityType: 'risk',
        entityId: json.data.id,
        items: stagedCreateAttachments,
      });
    }
    setStagedCreateAttachments([]);

    setIsCreateOpen(false);
    setForm({
      type: initialType,
      title: '',
      content: '',
      impact: 'medium',
      likelihood: 'medium',
      // fix/quick-ux item 8: 連続起票でも担当者は自分にリセット (上の create 初期値と整合)
      assigneeId: currentUserId,
      visibility: 'draft',
      riskNature: 'threat',
    });
    await reload();
  }

  async function handleExport() {
    window.open(`/api/projects/${projectId}/risks/export`, '_blank');
  }

  // T-22 Phase 22a: sync-import 用の 16 列 export (編集 dialog 完全網羅 format)
  async function handleSyncExport() {
    window.open(`/api/projects/${projectId}/risks/export?mode=sync`, '_blank');
  }

  // T-22 Phase 22a: 上書きインポート (sync-import) ダイアログ表示
  const [isSyncImportOpen, setIsSyncImportOpen] = useState(false);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">{headingLabel}</h2>
        <div className="flex gap-2">
          {systemRole === 'admin' && (
            <Button variant="outline" onClick={handleExport}>{tRisk('csvExport')}</Button>
          )}
          {/* T-22 Phase 22a: sync-import (往復編集) 用の export + import ボタン。canEdit (PM/TL + admin) のみ表示 */}
          {canCreate && (
            <>
              <Button variant="outline" onClick={handleSyncExport}>{tRisk('syncExport')}</Button>
              <Button variant="outline" onClick={() => setIsSyncImportOpen(true)}>{tRisk('syncImportButton')}</Button>
            </>
          )}
          {canCreate && (
            <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
              <DialogTrigger className="inline-flex shrink-0 items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-xs hover:bg-primary/90">{createLabel}</DialogTrigger>
              <DialogContent className={`max-w-[min(90vw,36rem)] max-h-[80vh] overflow-y-auto ${createFsClassName}`}>
                <DialogHeader>
                  <div className="flex items-center justify-between gap-2">
                    <DialogTitle>{createLabel}</DialogTitle>
                    <CreateFullscreenToggle />
                  </div>
                  <DialogDescription>
                    {typeFilter === 'issue' ? tRisk('createDescriptionIssue') : typeFilter === 'risk' ? tRisk('createDescriptionRisk') : tRisk('createDescriptionBoth')}
                  </DialogDescription>
                </DialogHeader>
                <form onSubmit={handleCreate} className="space-y-4">
                  {error && <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}
                  {/* PR #63: 公開範囲 / 脅威・好機 を最上位に配置 (設定忘れ防止の視線誘導) */}
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label>{tRisk('visibility')}</Label>
                      <select value={form.visibility} onChange={(e) => setForm({ ...form, visibility: e.target.value })} className={nativeSelectClass}>
                        {Object.entries(VISIBILITIES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                      </select>
                    </div>
                    {form.type === 'risk' && (
                      <div className="space-y-2">
                        <Label>{tRisk('threatOpportunity')}</Label>
                        <select value={form.riskNature} onChange={(e) => setForm({ ...form, riskNature: e.target.value })} className={nativeSelectClass}>
                          {Object.entries(RISK_NATURES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                        </select>
                      </div>
                    )}
                  </div>
                  {!typeFilter && (
                    <div className="space-y-2">
                      <Label>{tRisk('kind')}</Label>
                      <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as 'risk' | 'issue' })} className={nativeSelectClass}>
                        <option value="risk">{tRisk('labelRisk')}</option>
                        <option value="issue">{tRisk('labelIssue')}</option>
                      </select>
                    </div>
                  )}
                  <div className="space-y-2">
                    <Label>{tRisk('subject')}</Label>
                    <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} maxLength={100} required />
                  </div>
                  <div className="space-y-2">
                    <Label>{tField('content')} <span className="text-xs text-muted-foreground">{tRisk('optional')}</span></Label>
                    {/* refactor/list-create-content-optional (2026-04-27 #6): 件名必須、内容は任意 */}
                    <MarkdownTextarea value={form.content} onChange={(v) => setForm({ ...form, content: v })} rows={4} maxLength={2000} />
                  </div>
                  {/*
                    PR #65 Phase 2 (c): 入力中に類似する過去課題を inline 提示。
                    似た事象が過去に発生しているなら、ここで気付かせて未然対応に繋げる。
                  */}
                  {relatedIssues.length > 0 && (
                    <div className="rounded-md border border-amber-300 bg-warning/10 p-3 space-y-2">
                      <p className="text-xs font-semibold text-warning">
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
                                  className="text-xs text-info hover:underline"
                                >
                                  出典: {r.sourceProjectName}
                                </Link>
                              )}
                            </div>
                            <p className="text-xs text-foreground">{r.snippet}</p>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {/*
                    PR-γ / 項目 5/6: type=issue では impact→重要度 / likelihood→緊急度 にラベル切替。
                    priority は service 層で computePriority() により自動算出 (UI 入力不可)。
                  */}
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label>{form.type === 'issue' ? tRisk('importance') : tRisk('impact')}</Label>
                      <select value={form.impact} onChange={(e) => setForm({ ...form, impact: e.target.value })} className={nativeSelectClass}>
                        {Object.entries(IMPACT_LEVELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                      </select>
                    </div>
                    <div className="space-y-2">
                      <Label>{form.type === 'issue' ? tRisk('urgency') : tRisk('likelihood')}</Label>
                      <select value={form.likelihood} onChange={(e) => setForm({ ...form, likelihood: e.target.value })} className={nativeSelectClass}>
                        {Object.entries(IMPACT_LEVELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                      </select>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label>{tRisk('assignee')}</Label>
                    <select value={form.assigneeId} onChange={(e) => setForm({ ...form, assigneeId: e.target.value })} className={nativeSelectClass}>
                      <option value="">{tRisk('notSet')}</option>
                      {members.map((m) => <option key={m.userId} value={m.userId}>{m.userName}</option>)}
                    </select>
                  </div>
                  {/* PR #67: 起票と同時にエビデンス・関連チケット等の URL を登録可能 */}
                  <StagedAttachmentsInput
                    value={stagedCreateAttachments}
                    onChange={setStagedCreateAttachments}
                  />
                  <Button type="submit" className="w-full">{createLabel}</Button>
                </form>
              </DialogContent>
            </Dialog>
          )}
        </div>
      </div>

      {/* PR #165: フィルター UI (bulk 編集の二重防御に必須、一覧の絞り込みにも有用) */}
      <div className="rounded-md border bg-muted/30 p-3">
        <div className="mb-2 flex items-center gap-2">
          <span className="text-sm font-medium">{tRisk('filter')}</span>
          {!filterApplied && (
            <span className="text-xs text-muted-foreground">{tRisk('filterRequiredHint')}</span>
          )}
        </div>
        <div className="grid grid-cols-1 gap-2 md:grid-cols-4">
          <div>
            <Label htmlFor={`risk-filter-state-${typeFilter ?? 'all'}`} className="text-xs">{tRisk('state')}</Label>
            <select
              id={`risk-filter-state-${typeFilter ?? 'all'}`}
              value={bulkFilter.state}
              onChange={(e) => setBulkFilter((f) => ({ ...f, state: e.target.value }))}
              className={nativeSelectClass}
            >
              <option value="">{tRisk('all')}</option>
              {Object.entries(RISK_ISSUE_STATES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </div>
          <div>
            {/* PR-γ / 項目 4 + 9: フィルタは impact (影響度/重要度) ではなく priority (優先度) で */}
            <Label htmlFor={`risk-filter-priority-${typeFilter ?? 'all'}`} className="text-xs">{tRisk('priority')}</Label>
            <select
              id={`risk-filter-priority-${typeFilter ?? 'all'}`}
              value={bulkFilter.priority}
              onChange={(e) => setBulkFilter((f) => ({ ...f, priority: e.target.value }))}
              className={nativeSelectClass}
            >
              <option value="">{tRisk('all')}</option>
              {Object.entries(PRIORITIES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </div>
          <div className="md:col-span-2">
            <Label htmlFor={`risk-filter-keyword-${typeFilter ?? 'all'}`} className="text-xs">{tRisk('keyword')}</Label>
            <Input
              id={`risk-filter-keyword-${typeFilter ?? 'all'}`}
              value={bulkFilter.keyword}
              onChange={(e) => setBulkFilter((f) => ({ ...f, keyword: e.target.value }))}
              placeholder={tRisk('keywordPlaceholder')}
            />
          </div>
          <div className="md:col-span-4">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={bulkFilter.mineOnly}
                onChange={(e) => setBulkFilter((f) => ({ ...f, mineOnly: e.target.checked }))}
                className="rounded"
              />
              {tRisk('mineOnly')}
            </label>
          </div>
        </div>
      </div>

      {/* PR #165: 一括選択ツールバー (フィルター適用時のみ表示) */}
      {filterApplied && (
        <div className="flex items-center justify-between gap-2 py-2">
          <div className="text-sm text-muted-foreground">
            一括編集対象 (自分が起票): {selectableIds.length} 件 / 選択中: {selectedIds.size} 件
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setSelectedIds(new Set())}
              disabled={selectedIds.size === 0}
            >
              選択解除
            </Button>
            <Button size="sm" onClick={openBulk} disabled={selectedIds.size === 0}>
              一括編集 ({selectedIds.size})
            </Button>
          </div>
        </div>
      )}

      <ResizableColumnsProvider tableKey={`project-risks-${typeFilter ?? 'all'}`}>
        <div className="flex justify-end pb-2">
          <ResetColumnsButton />
        </div>
      <Table>
        <TableHeader>
          <TableRow>
            {filterApplied && (
              <ResizableHead columnKey="select" defaultWidth={36}>
                <input
                  type="checkbox"
                  aria-label={tRisk('selectAllEditable')}
                  checked={allSelectableSelected}
                  disabled={selectableIds.length === 0}
                  onChange={toggleAllIds}
                  className="rounded"
                />
              </ResizableHead>
            )}
            {!typeFilter && <ResizableHead columnKey="type" defaultWidth={80}>{tRisk('kind')}</ResizableHead>}
            <ResizableHead columnKey="title" defaultWidth={240}>{tRisk('subject')}</ResizableHead>
            {/* PR-γ / 項目 3 + 8: 影響度/重要度カラムは非表示。詳細は編集 dialog で確認。 */}
            <ResizableHead columnKey="priority" defaultWidth={80}>{tRisk('priority')}</ResizableHead>
            <ResizableHead columnKey="state" defaultWidth={100}>{tRisk('state')}</ResizableHead>
            {/* feat/account-lock-and-ui-consistency: 公開範囲列を追加。編集ダイアログで
                visibility を変更しても一覧に表示されず「画面上データが更新されていない」
                ように見える bug の解消 (knowledge/memo は既存で表示済、risk/retro が漏れ) */}
            <ResizableHead columnKey="visibility" defaultWidth={90}>{tRisk('visibility')}</ResizableHead>
            <ResizableHead columnKey="assignee" defaultWidth={120}>{tRisk('assignee')}</ResizableHead>
            <ResizableHead columnKey="createdAt" defaultWidth={110}>{tRisk('reportedAt')}</ResizableHead>
            {/* PR #67: 添付リンク列 */}
            <ResizableHead columnKey="attachments" defaultWidth={200}>{tRisk('attachment')}</ResizableHead>
            {/* 2026-04-24: 作成者本人だけが削除ボタンを使うので、自分の行が 1 つでもあれば列を出す */}
            {filteredRisks.some((x) => x.reporterId === currentUserId) && (
              <ResizableHead columnKey="actions" defaultWidth={80}>{tRisk('actions')}</ResizableHead>
            )}
          </TableRow>
        </TableHeader>
        <TableBody>
          {filteredRisks.map((r) => {
            const isOwner = r.reporterId === currentUserId;
            const canRowEdit = isOwner; // 2026-04-24: 編集は作成者本人のみ
            return (
            <TableRow
              key={r.id}
              // 2026-04-24: 行クリックで編集ダイアログ (作成者本人のみ active)
              className={canRowEdit ? 'cursor-pointer hover:bg-muted' : ''}
              onClick={canRowEdit ? () => setEditingRisk(r) : undefined}
            >
              {filterApplied && (
                <TableCell onClick={(e) => e.stopPropagation()}>
                  {r.viewerIsCreator ? (
                    <input
                      type="checkbox"
                      aria-label={tRisk('addToBulkEdit', { title: r.title })}
                      checked={selectedIds.has(r.id)}
                      onChange={() => toggleOneId(r.id)}
                      className="rounded"
                    />
                  ) : (
                    <span className="text-xs text-muted-foreground" title={tRisk('rowNotEditableByOthers')}>-</span>
                  )}
                </TableCell>
              )}
              {!typeFilter && <TableCell><Badge variant="outline">{r.type === 'risk' ? tRisk('labelRisk') : tRisk('labelIssue')}</Badge></TableCell>}
              <TableCell className="font-medium">{r.title}</TableCell>
              {/* PR-γ: 影響度/重要度セルは非表示 (一覧は priority のみ) */}
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
              {/* feat/account-lock-and-ui-consistency: 公開範囲表示 (編集後の即時反映確認用) */}
              <TableCell>
                <Badge variant={r.visibility === 'public' ? 'default' : 'outline'}>
                  {VISIBILITIES[r.visibility as keyof typeof VISIBILITIES] || r.visibility}
                </Badge>
              </TableCell>
              <TableCell>{r.assigneeName || '-'}</TableCell>
              <TableCell>{formatDate(r.createdAt)}</TableCell>
              {/* PR #67: 添付リンク chips */}
              <TableCell onClick={(e) => e.stopPropagation()}>
                <AttachmentsCell items={attachmentsByEntity[r.id] ?? []} />
              </TableCell>
              {/* 2026-04-24: 削除ボタンは作成者本人のみ (admin は全○○ から別経路) */}
              {isOwner && (
                <TableCell onClick={(e) => e.stopPropagation()}>
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-destructive"
                    onClick={async () => {
                      if (!confirm(tRisk('deleteConfirm'))) return;
                      await withLoading(() =>
                        fetch(`/api/projects/${projectId}/risks/${r.id}`, { method: 'DELETE' }),
                      );
                      await reload();
                    }}
                  >
                    {tRisk('delete')}
                  </Button>
                </TableCell>
              )}
            </TableRow>
            );
          })}
          {filteredRisks.length === 0 && (
            <TableRow>
              {/* PR #67: 添付列 +1、2026-04-24: actions 列は自分の行があるときのみ +1、PR #165: filterApplied 時 select 列 +1 */}
              <TableCell
                colSpan={
                  (filteredRisks.some((x) => x.reporterId === currentUserId) ? 8 : 7)
                  + (typeFilter ? 0 : 1)
                  + (filterApplied ? 1 : 0)
                }
                className="py-8 text-center text-muted-foreground"
              >
                {typeFilter === 'issue' ? tRisk('noneIssue') : typeFilter === 'risk' ? tRisk('noneRisk') : tRisk('noneBothSpace')}
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
      </ResizableColumnsProvider>

      <RiskEditDialog
        risk={editingRisk}
        members={members}
        open={editingRisk != null}
        onOpenChange={(v) => { if (!v) setEditingRisk(null); }}
        onSaved={reload}
      />

      {/* PR #165: 一括編集ダイアログ */}
      <Dialog open={bulkOpen} onOpenChange={setBulkOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>一括編集 ({selectedIds.size} 件)</DialogTitle>
            <DialogDescription>
              チェックを入れた項目だけが対象に適用されます。
              他人が起票した行はサーバ側で自動的に除外されます。
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="flex items-start gap-2">
              <input
                type="checkbox"
                checked={bulkApply.state}
                onChange={(e) => setBulkApply((a) => ({ ...a, state: e.target.checked }))}
                className="mt-2 rounded"
                aria-label={tRisk('bulkApplyState')}
              />
              <div className="flex-1 space-y-1">
                <Label className="text-sm">{tRisk('state')}</Label>
                <div className={bulkApply.state ? '' : 'pointer-events-none opacity-50'}>
                  <select
                    value={bulkValues.state}
                    onChange={(e) => setBulkValues((b) => ({ ...b, state: e.target.value }))}
                    className={nativeSelectClass}
                  >
                    {Object.entries(RISK_ISSUE_STATES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                  </select>
                </div>
              </div>
            </div>

            <div className="flex items-start gap-2">
              <input
                type="checkbox"
                checked={bulkApply.assigneeId}
                onChange={(e) => setBulkApply((a) => ({ ...a, assigneeId: e.target.checked }))}
                className="mt-2 rounded"
                aria-label={tRisk('bulkApplyAssignee')}
              />
              <div className="flex-1 space-y-1">
                <Label className="text-sm">{tRisk('assignee')}</Label>
                <div className={bulkApply.assigneeId ? 'space-y-1' : 'pointer-events-none space-y-1 opacity-50'}>
                  <select
                    value={bulkValues.assigneeId}
                    disabled={bulkAssigneeClear}
                    onChange={(e) => setBulkValues((b) => ({ ...b, assigneeId: e.target.value }))}
                    className={nativeSelectClass}
                  >
                    <option value="">{tRisk('notSetWithoutAssignee')}</option>
                    {members.map((m) => <option key={m.userId} value={m.userId}>{m.userName}</option>)}
                  </select>
                  <label className="flex items-center gap-1 text-xs text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={bulkAssigneeClear}
                      onChange={(e) => setBulkAssigneeClear(e.target.checked)}
                      className="rounded"
                    />
                    担当者をクリア (未割り当てに戻す)
                  </label>
                </div>
              </div>
            </div>

            <div className="flex items-start gap-2">
              <input
                type="checkbox"
                checked={bulkApply.deadline}
                onChange={(e) => setBulkApply((a) => ({ ...a, deadline: e.target.checked }))}
                className="mt-2 rounded"
                aria-label={tRisk('bulkApplyDeadline')}
              />
              <div className="flex-1 space-y-1">
                <Label className="text-sm">{tRisk('deadline')}</Label>
                <div className={bulkApply.deadline ? 'space-y-1' : 'pointer-events-none space-y-1 opacity-50'}>
                  {/* feat/date-field-clear-rename: 単発編集 dialog (RiskEditDialog) と同じ DateFieldWithActions を流用し
                      「今日」「クリア」ボタンを必ず提供する (画面横断の操作一貫性 + 横展開漏れ防止) */}
                  <DateFieldWithActions
                    value={bulkValues.deadline}
                    onChange={(v) => setBulkValues((b) => ({ ...b, deadline: v }))}
                    disabled={bulkDeadlineClear}
                  />
                  <label className="flex items-center gap-1 text-xs text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={bulkDeadlineClear}
                      onChange={(e) => setBulkDeadlineClear(e.target.checked)}
                      className="rounded"
                    />
                    期限をクリア
                  </label>
                </div>
              </div>
            </div>
          </div>

          {bulkError && (
            <div className="mt-3 rounded-md bg-destructive/10 p-2 text-sm text-destructive">
              {bulkError}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setBulkOpen(false)}>{tAction('cancel')}</Button>
            <Button onClick={submitBulk}>{tRisk('apply')}</Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* T-22 Phase 22a: 上書きインポート (sync-import) ダイアログ */}
      <EntitySyncImportDialog
        apiBasePath={`/api/projects/${projectId}/risks/sync-import`}
        i18nNamespace="risk.syncImport"
        open={isSyncImportOpen}
        onOpenChange={setIsSyncImportOpen}
        onImported={async () => { await reload(); }}
      />
    </div>
  );
}
