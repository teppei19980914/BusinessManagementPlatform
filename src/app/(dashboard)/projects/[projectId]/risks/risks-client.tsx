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
import { useToast } from '@/components/toast-provider';
import { Button } from '@/components/ui/button';
import { EntitySyncImportDialog } from '@/components/dialogs/entity-sync-import-dialog';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  TableBody, TableCell, TableHeader, TableRow,
} from '@/components/ui/table';
import { ResizableHead } from '@/components/ui/resizable-columns';
import { SortableResizableHead } from '@/components/sort/sortable-resizable-head';
import { useMultiSort } from '@/components/sort/use-multi-sort';
import { multiSort } from '@/lib/multi-sort';
import { ResizableTableShell } from '@/components/common/resizable-table-shell';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';
import { nativeSelectClass } from '@/components/ui/native-select-style';
import { RiskEditDialog } from '@/components/dialogs/risk-edit-dialog';
// UI_PATTERNS §35 (2026-05-24): 一括 visibility 編集ツールバーを共通化
import { CrossListBulkVisibilityToolbar } from '@/components/cross-list-bulk-visibility-toolbar';
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
// Phase C 要件 19: キーワード OR 検索ヘルパ
import { matchesAnyKeyword } from '@/lib/text-search';
// Phase E 要件 1〜3 (2026-04-29): 共通バッジ + 行クリック + フィルタバー + 一括選択部品
import { VisibilityBadge } from '@/components/common/visibility-badge';
import { ClickableRow } from '@/components/common/clickable-row';
import { FilterBar } from '@/components/common/filter-bar';
import { BulkSelectHeader, BulkSelectCell } from '@/components/common/bulk-select';
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

// PR feat/sortable-columns: カラム列キー → 行値の getter。multiSort の比較に使う。
function getProjectRiskSortValue(r: RiskDTO, columnKey: string): unknown {
  switch (columnKey) {
    case 'type': return r.type;
    case 'title': return r.title;
    case 'priority': return r.priority;
    case 'state': return r.state;
    case 'visibility': return r.visibility;
    case 'assignee': return r.assigneeName ?? '';
    case 'createdAt': return r.createdAt;
    default: return null;
  }
}

export function RisksClient({ projectId, risks, members, canCreate, currentUserId, systemRole, typeFilter, onReload }: Props) {
  const router = useRouter();
  const tRisk = useTranslations('risk');
  const tField = useTranslations('field');
  const { withLoading } = useLoading();
  const { showSuccess, showError } = useToast();
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
    // feat/risk-issue-4-section (2026-05-26): 4 セクション化
    //   - occurrence : 発生事象 (issue) / 考えられる事象 (risk) — public 時必須
    //   - cause      : 直接原因 (issue) / 考えられる原因 (risk)
    //   - responsePolicy : 対応策 (issue) / 考えられる対応策 (risk)
    //   - content    : メモ (両 type 共通、旧「内容」のリネーム)
    occurrence: '',
    cause: '',
    responsePolicy: '',
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

  // PR feat/sortable-columns (2026-05-01): カラムソート (sessionStorage 永続化、複数列対応)。
  const { sortState, setSortColumn } = useMultiSort('sort:project-risks');

  const filteredRisks = useMemo(() => {
    let xs = typeFilter ? risks.filter((r) => r.type === typeFilter) : risks;
    if (bulkFilter.state) xs = xs.filter((r) => r.state === bulkFilter.state);
    if (bulkFilter.priority) xs = xs.filter((r) => r.priority === bulkFilter.priority);
    if (bulkFilter.mineOnly) xs = xs.filter((r) => r.viewerIsCreator === true);
    if (bulkFilter.keyword.trim()) {
      // Phase C 要件 19 (2026-04-28): 空白区切りで OR 検索 (matchesAnyKeyword)
      xs = xs.filter((r) => matchesAnyKeyword(bulkFilter.keyword, [r.title, r.content]));
    }
    return multiSort(xs, sortState, getProjectRiskSortValue);
  }, [risks, typeFilter, bulkFilter, sortState]);
  // Phase A 要件 6 で h2 ヘディング削除に伴い headingLabel は未使用化、削除して lint clean に。
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
  // fix/list-export-import-bugs (2026-05-26): チェックボックスは export + bulk visibility 兼用に拡張。
  //   全行選択可とし、bulk visibility は サーバ側で per-row 認可 (viewerCanEdit=false は silent skip)。
  const selectableIds = filteredRisks.map((r) => r.id);
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

  // UI_PATTERNS §35 (2026-05-24): 旧 state+assigneeId+deadline 複合 bulk dialog を撤廃し、
  // CrossListBulkVisibilityToolbar (visibility-only) に統一。bulk 用ローカル state は不要。

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    const body = {
      ...form,
      // feat/risk-issue-4-section (2026-05-26): 空文字は null として送信 (DB は nullable)
      occurrence: form.occurrence.trim() || null,
      cause: form.cause.trim() || null,
      responsePolicy: form.responsePolicy.trim() || null,
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
      const msg = json.error?.message || json.error?.details?.[0]?.message || tRisk('createFailed');
      setError(msg);
      showError(form.type === 'risk' ? 'リスクの起票に失敗しました' : '課題の起票に失敗しました');
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
    showSuccess(form.type === 'risk' ? 'リスクを起票しました' : '課題を起票しました');
    setForm({
      type: initialType,
      title: '',
      // feat/risk-issue-4-section (2026-05-26): 連続起票時もフィールドをクリア
      occurrence: '',
      cause: '',
      responsePolicy: '',
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

  // fix/list-export-import-bugs (2026-05-26): 共通の export ハンドラ。
  //   selectedIds.size === 0 のとき全件 export、それ以外なら選択 ID のみ。
  async function postExport(mode: 'csv' | 'sync', filename: string) {
    const body: Record<string, unknown> = {};
    if (selectedIds.size > 0) body.ids = [...selectedIds];
    const url = mode === 'sync'
      ? `/api/projects/${projectId}/risks/export?mode=sync`
      : `/api/projects/${projectId}/risks/export`;
    const res = await withLoading(() =>
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
    if (!res.ok) {
      showError('リスク/課題のエクスポートに失敗しました');
      return;
    }
    const csvText = await res.text();
    const blob = new Blob(['﻿' + csvText], { type: 'text/csv; charset=utf-8' });
    const dlUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = dlUrl;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(dlUrl);
  }

  async function handleExport() {
    await postExport('csv', `risks_${projectId}.csv`);
  }

  // T-22 Phase 22a: sync-import 用の export (編集 dialog 完全網羅 format)
  async function handleSyncExport() {
    await postExport('sync', `risks_sync_${projectId}.csv`);
  }

  // T-22 Phase 22a: 上書きインポート (sync-import) ダイアログ表示
  const [isSyncImportOpen, setIsSyncImportOpen] = useState(false);

  return (
    <div className="space-y-6">
      {/* Phase A 要件 6: h2 ページタイトル削除 (タブ名と重複のため) */}
      <div className="flex items-center justify-end">
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
                    <Label>
                      {tRisk('subject')}
                      {/* 2026-05-11: 公開範囲 = 自分のみ (draft) なら任意、全メンバー (public) なら必須 */}
                      {form.visibility === 'draft' && (
                        <span className="ml-2 text-xs text-muted-foreground">{tRisk('optional')}</span>
                      )}
                    </Label>
                    <Input
                      value={form.title}
                      onChange={(e) => setForm({ ...form, title: e.target.value })}
                      maxLength={100}
                      required={form.visibility === 'public'}
                    />
                  </div>
                  {/* feat/risk-issue-4-section (2026-05-26): 4 セクション化
                      type=issue → 発生事象 / 直接原因 / 対応策 / メモ
                      type=risk  → 考えられる事象 / 考えられる原因 / 考えられる対応策 / メモ
                      DB 列は両 type 共通 (occurrence / cause / responsePolicy / content) */}
                  <div className="space-y-2">
                    <Label>
                      {form.type === 'risk' ? tField('riskOccurrence') : tField('issueOccurrence')}
                      {form.visibility !== 'public' && (
                        <span className="ml-2 text-xs text-muted-foreground">{tRisk('optional')}</span>
                      )}
                    </Label>
                    <MarkdownTextarea
                      value={form.occurrence}
                      onChange={(v) => setForm({ ...form, occurrence: v })}
                      rows={3}
                      maxLength={2000}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>
                      {form.type === 'risk' ? tField('riskCause') : tField('issueCause')}{' '}
                      <span className="text-xs text-muted-foreground">{tRisk('optional')}</span>
                    </Label>
                    <MarkdownTextarea
                      value={form.cause}
                      onChange={(v) => setForm({ ...form, cause: v })}
                      rows={3}
                      maxLength={2000}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>
                      {form.type === 'risk' ? tField('riskCountermeasure') : tField('issueCountermeasure')}{' '}
                      <span className="text-xs text-muted-foreground">{tRisk('optional')}</span>
                    </Label>
                    <MarkdownTextarea
                      value={form.responsePolicy}
                      onChange={(v) => setForm({ ...form, responsePolicy: v })}
                      rows={3}
                      maxLength={2000}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>
                      {tField('memo')}{' '}
                      <span className="text-xs text-muted-foreground">{tRisk('optional')}</span>
                    </Label>
                    <MarkdownTextarea
                      value={form.content}
                      onChange={(v) => setForm({ ...form, content: v })}
                      rows={3}
                      maxLength={2000}
                    />
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

      {/* PR #165 + Phase E 共通化: フィルター UI (filter は撤廃済、絞り込み補助のみ) */}
      <FilterBar title={tRisk('filter')}>
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
      </FilterBar>

      {/* UI_PATTERNS §35 (2026-05-24): 5 一覧画面で visibility-only 一括編集に統一。
          画面固有 FilterBar (state + priority + mineOnly) は上部で別途描画しているため、
          内蔵 FilterBar は hideFilterBar=true で抑止する。 */}
      <CrossListBulkVisibilityToolbar
        endpoint={`/api/projects/${projectId}/risks/bulk`}
        formIdPrefix={`project-risks-${projectId}-${typeFilter ?? 'all'}`}
        filter={{ keyword: bulkFilter.keyword, mineOnly: bulkFilter.mineOnly }}
        onFilterChange={(next) => setBulkFilter((f) => ({ ...f, keyword: next.keyword, mineOnly: next.mineOnly }))}
        selectedIds={selectedIds}
        onSelectionClear={() => setSelectedIds(new Set())}
        visibilityOptions={[
          { value: 'draft', label: tRisk('visibilityDraftLabel') },
          { value: 'public', label: tRisk('visibilityPublicLabel') },
        ]}
        entityLabel={typeFilter === 'issue' ? tRisk('labelIssue') : tRisk('labelRisk')}
        onApplied={reload}
        hideFilterBar
      />

      <ResizableTableShell tableKey={`project-risks-${typeFilter ?? 'all'}`}>
        <TableHeader>
          <TableRow>
            <ResizableHead columnKey="select" defaultWidth={36}>
              <BulkSelectHeader
                allSelected={allSelectableSelected}
                totalSelectable={selectableIds.length}
                onToggleAll={toggleAllIds}
                ariaLabel={tRisk('selectAllEditable')}
              />
            </ResizableHead>
            {!typeFilter && <SortableResizableHead columnKey="type" defaultWidth={80} label={tRisk('kind')} sortState={sortState} onSortChange={setSortColumn} />}
            <SortableResizableHead columnKey="title" defaultWidth={240} label={tRisk('subject')} sortState={sortState} onSortChange={setSortColumn} />
            {/* PR-γ / 項目 3 + 8: 影響度/重要度カラムは非表示。詳細は編集 dialog で確認。 */}
            <SortableResizableHead columnKey="priority" defaultWidth={80} label={tRisk('priority')} sortState={sortState} onSortChange={setSortColumn} />
            <SortableResizableHead columnKey="state" defaultWidth={100} label={tRisk('state')} sortState={sortState} onSortChange={setSortColumn} />
            {/* feat/account-lock-and-ui-consistency: 公開範囲列を追加。編集ダイアログで
                visibility を変更しても一覧に表示されず「画面上データが更新されていない」
                ように見える bug の解消 (knowledge/memo は既存で表示済、risk/retro が漏れ) */}
            <SortableResizableHead columnKey="visibility" defaultWidth={90} label={tRisk('visibility')} sortState={sortState} onSortChange={setSortColumn} />
            <SortableResizableHead columnKey="assignee" defaultWidth={120} label={tRisk('assignee')} sortState={sortState} onSortChange={setSortColumn} />
            <SortableResizableHead columnKey="createdAt" defaultWidth={110} label={tRisk('reportedAt')} sortState={sortState} onSortChange={setSortColumn} />
            {/* PR #67: 添付リンク列 */}
            <ResizableHead columnKey="attachments" defaultWidth={200}>{tRisk('attachment')}</ResizableHead>
            {/* 2026-04-24: 作成者本人だけが削除ボタンを使うので、自分の行が 1 つでもあれば列を出す。
                feat/asset-assignee-expansion (2026-05-26): 担当者も削除可能なので OR で拡張。 */}
            {filteredRisks.some((x) => x.reporterId === currentUserId || x.assigneeId === currentUserId) && (
              <ResizableHead columnKey="actions" defaultWidth={80}>{tRisk('actions')}</ResizableHead>
            )}
          </TableRow>
        </TableHeader>
        <TableBody>
          {filteredRisks.map((r) => {
            // feat/asset-assignee-expansion (2026-05-26): 作成者 OR 担当者を編集可能 (= 削除/bulk 対象)
            const canEdit = r.viewerCanEdit === true
              || r.reporterId === currentUserId
              || r.assigneeId === currentUserId;
            const isOwner = canEdit; // 旧名残: delete ボタン表示判定 (担当者にも開放)
            // Phase B 要件 5 (2026-04-28): 行クリックで dialog を開く動作は **全員** で active 化
            //   (詳細閲覧の用途を含む)。編集権限は dialog 内で `readOnly` により分岐し、
            //   非作成者 & 非担当者は readOnly モードで詳細表示のみ可能。
            return (
            <ClickableRow
              key={r.id}
              onClick={() => setEditingRisk(r)}
            >
              <TableCell onClick={(e) => e.stopPropagation()}>
                {/* fix/list-export-import-bugs (2026-05-26): export 対象指定と bulk visibility 兼用のため全行チェック可 */}
                <BulkSelectCell
                  canSelect={true}
                  selected={selectedIds.has(r.id)}
                  onToggle={() => toggleOneId(r.id)}
                  ariaLabel={tRisk('addToBulkEdit', { title: r.title })}
                />
              </TableCell>
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
                <VisibilityBadge
                  visibility={r.visibility}
                  label={VISIBILITIES[r.visibility as keyof typeof VISIBILITIES] || r.visibility}
                />
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
                      const res = await withLoading(() =>
                        fetch(`/api/projects/${projectId}/risks/${r.id}`, { method: 'DELETE' }),
                      );
                      if (!res.ok) {
                        showError(r.type === 'risk' ? 'リスクの削除に失敗しました' : '課題の削除に失敗しました');
                        return;
                      }
                      showSuccess(r.type === 'risk' ? 'リスクを削除しました' : '課題を削除しました');
                      await reload();
                    }}
                  >
                    {tRisk('delete')}
                  </Button>
                </TableCell>
              )}
            </ClickableRow>
            );
          })}
          {filteredRisks.length === 0 && (
            <TableRow>
              {/* PR #67: 添付列 +1、2026-04-24: actions 列は自分の行があるときのみ +1、
                  Phase C 要件 18: select 列は常時表示で +1 */}
              <TableCell
                colSpan={
                  (filteredRisks.some((x) => x.reporterId === currentUserId || x.assigneeId === currentUserId) ? 9 : 8)
                  + (typeFilter ? 0 : 1)
                }
                className="py-8 text-center text-muted-foreground"
              >
                {typeFilter === 'issue' ? tRisk('noneIssue') : typeFilter === 'risk' ? tRisk('noneRisk') : tRisk('noneBothSpace')}
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </ResizableTableShell>

      {/* Phase B 要件 5: 非作成者は readOnly で詳細表示のみ可。
          feat/asset-assignee-expansion (2026-05-26): 担当者も編集可能。
          systemRole='admin' は他人作成でも編集可能 (既存仕様維持)。 */}
      <RiskEditDialog
        risk={editingRisk}
        members={members}
        currentProjectId={projectId}
        open={editingRisk != null}
        onOpenChange={(v) => { if (!v) setEditingRisk(null); }}
        onSaved={reload}
        readOnly={
          editingRisk != null
          && editingRisk.reporterId !== currentUserId
          && editingRisk.assigneeId !== currentUserId
        }
      />

      {/* UI_PATTERNS §35 (2026-05-24): 旧 state+assigneeId+deadline 複合 bulk dialog は撤廃。
          一括編集は CrossListBulkVisibilityToolbar (visibility-only) に統一済。 */}

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
