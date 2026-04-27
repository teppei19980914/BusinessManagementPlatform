'use client';

/**
 * 全リスク / 全課題画面 (横断表示) のテーブルコンポーネント。
 *
 * 役割:
 *   全プロジェクト横断で visibility='public' のリスク/課題を一覧表示する。
 *   PR #60 #1 でリスクと課題を別タブに分離 (本コンポーネントは type を prop で受け取る)。
 *
 * 行クリック動作 (2026-04-24 改修):
 *   - 常に **read-only ダイアログ** で詳細を開く (編集不可)
 *   - 編集はプロジェクト内「リスク/課題一覧」画面から作成者本人のみ実施
 *
 * PR #161 (feat/cross-list-bulk-update) 追加:
 *   - フィルター UI (状態 / 影響度 / キーワード) を上部に配置
 *   - **フィルターを 1 つ以上適用したときのみ** チェックボックス列を表示し、bulk 選択を許可
 *   - bulk 編集ダイアログ (状態 / 担当者 / 期限) を提供
 *   - 「viewerIsCreator=true」の行のみ checkbox 有効 (作成者本人だけが編集可)
 *   - 全件更新の事故防止: フィルター無しでは bulk 操作 UI を出さない
 *
 * 関連: SPECIFICATION.md (全リスク・全課題画面)、DEVELOPER_GUIDE §5.21
 */

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  Table, TableBody, TableCell, TableHeader, TableRow,
} from '@/components/ui/table';
import { RiskEditDialog } from '@/components/dialogs/risk-edit-dialog';
import { PRIORITIES } from '@/types';
import type { AllRiskDTO } from '@/services/risk.service';
import type { MemberDTO } from '@/services/member.service';
import { AdminRiskDeleteButton } from './admin-delete-button';
import { useFormatters } from '@/lib/use-formatters';
import { useBatchAttachments } from '@/components/attachments/use-batch-attachments';
import { AttachmentsCell } from '@/components/attachments/attachments-cell';
import {
  ResizableColumnsProvider,
  ResizableHead,
  ResetColumnsButton,
} from '@/components/ui/resizable-columns';
import { useLoading } from '@/components/loading-overlay';

const typeColors: Record<string, 'default' | 'destructive' | 'outline'> = {
  risk: 'outline',
  issue: 'destructive',
};

const STATE_LABELS: Record<string, string> = {
  open: '未対応',
  in_progress: '対応中',
  monitoring: '監視中',
  resolved: '解消',
};

type FilterState = {
  state: string; // '' = 未指定
  impact: string;
  keyword: string;
};

const EMPTY_FILTER: FilterState = { state: '', impact: '', keyword: '' };

/**
 * フィルター fingerprint を「実質的に何かが指定されているか」で判定。
 * type prop (typeFilter) は親が渡す暗黙フィルターなので、本判定では除外せず、
 * 親側で「全リスク」/「全課題」タブを選んだ時点で常に true 扱いにする (server validator も同方針)。
 */
function isAnyFilterApplied(f: FilterState, hasTypeFilter: boolean): boolean {
  return Boolean(hasTypeFilter || f.state || f.impact || (f.keyword && f.keyword.trim().length > 0));
}

export function AllRisksTable({
  risks,
  isAdmin,
  typeFilter,
}: {
  risks: AllRiskDTO[];
  isAdmin: boolean;
  /** PR #60 #1: 'risk' / 'issue' で絞り込み (未指定なら両方表示) */
  typeFilter?: 'risk' | 'issue';
}) {
  const router = useRouter();
  const { formatDateTime } = useFormatters();
  const { withLoading } = useLoading();

  // -------- フィルター状態 --------
  const [filter, setFilter] = useState<FilterState>(EMPTY_FILTER);
  const filterApplied = isAnyFilterApplied(filter, Boolean(typeFilter));

  // typeFilter (タブ) → 状態フィルター → 影響度フィルター → キーワードの順に絞り込み
  const filteredRisks = useMemo(() => {
    let xs = typeFilter ? risks.filter((r) => r.type === typeFilter) : risks;
    if (filter.state) xs = xs.filter((r) => r.state === filter.state);
    if (filter.impact) xs = xs.filter((r) => r.impact === filter.impact);
    if (filter.keyword.trim()) {
      const kw = filter.keyword.trim().toLowerCase();
      xs = xs.filter((r) => r.title.toLowerCase().includes(kw) || r.content.toLowerCase().includes(kw));
    }
    return xs;
  }, [risks, typeFilter, filter]);

  // -------- 行クリック (read-only 詳細表示) --------
  const [editingRisk, setEditingRisk] = useState<AllRiskDTO | null>(null);
  const [members, setMembers] = useState<MemberDTO[]>([]);
  const attachmentsByEntity = useBatchAttachments(
    'risk',
    filteredRisks.map((r) => r.id),
  );

  async function handleRowClick(r: AllRiskDTO) {
    if (r.canAccessProject) {
      try {
        const res = await fetch(`/api/projects/${r.projectId}/members`);
        if (res.ok) {
          const json = await res.json();
          setMembers(json.data ?? []);
        }
      } catch {
        setMembers([]);
      }
    } else {
      setMembers([]);
    }
    setEditingRisk(r);
  }

  // -------- 一括選択 (PR #161) --------
  // フィルター未適用時は selection 機能自体を出さない (危険性排除)
  // viewerIsCreator=true の行のみ checkbox を有効化 (作成者だけが編集可)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const selectableRisks = filterApplied ? filteredRisks.filter((r) => r.viewerIsCreator) : [];
  const selectableIds = selectableRisks.map((r) => r.id);
  const allSelectableSelected
    = selectableIds.length > 0 && selectableIds.every((id) => selectedIds.has(id));

  function toggleOne(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    if (allSelectableSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(selectableIds));
    }
  }

  // -------- 一括編集ダイアログ (PR #161) --------
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkApply, setBulkApply] = useState({ state: false, assigneeId: false, deadline: false });
  const [bulkValues, setBulkValues] = useState<{ state: string; assigneeId: string; deadline: string }>({
    state: 'open',
    assigneeId: '',
    deadline: '',
  });
  // 「担当者をクリア」/「期限をクリア」を明示的に送信する 2 値 (チェック付きで値が空なら null 送信)
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
      setBulkError('更新する項目を 1 つ以上指定してください');
      return;
    }

    const res = await withLoading(() =>
      fetch('/api/risks/bulk', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ids: Array.from(selectedIds),
          filterFingerprint: {
            type: typeFilter,
            state: filter.state || undefined,
            impact: filter.impact || undefined,
            keyword: filter.keyword.trim() || undefined,
          },
          patch,
        }),
      }),
    );

    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setBulkError(j?.message || j?.error || '一括更新に失敗しました');
      return;
    }
    setBulkOpen(false);
    setSelectedIds(new Set());
    router.refresh();
  }

  // -------- 描画 --------
  return (
    <ResizableColumnsProvider tableKey="all-risks">
      {/* フィルター UI (PR #161) */}
      <div className="rounded-md border bg-muted/30 p-3">
        <div className="mb-2 flex items-center gap-2">
          <span className="text-sm font-medium">フィルター</span>
          {!filterApplied && (
            <span className="text-xs text-muted-foreground">
              (一括編集には何らかのフィルター適用が必要です)
            </span>
          )}
        </div>
        <div className="grid grid-cols-1 gap-2 md:grid-cols-4">
          <div>
            <Label htmlFor="filter-state" className="text-xs">状態</Label>
            <Select
              value={filter.state || '__all__'}
              onValueChange={(v) => {
                const next = v ?? '__all__';
                setFilter((f) => ({ ...f, state: next === '__all__' ? '' : next }));
              }}
            >
              <SelectTrigger id="filter-state"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">すべて</SelectItem>
                {Object.entries(STATE_LABELS).map(([k, v]) => (
                  <SelectItem key={k} value={k}>{v}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="filter-impact" className="text-xs">影響度</Label>
            <Select
              value={filter.impact || '__all__'}
              onValueChange={(v) => {
                const next = v ?? '__all__';
                setFilter((f) => ({ ...f, impact: next === '__all__' ? '' : next }));
              }}
            >
              <SelectTrigger id="filter-impact"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">すべて</SelectItem>
                {Object.entries(PRIORITIES).map(([k, v]) => (
                  <SelectItem key={k} value={k}>{v}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="md:col-span-2">
            <Label htmlFor="filter-keyword" className="text-xs">キーワード (件名・内容)</Label>
            <Input
              id="filter-keyword"
              value={filter.keyword}
              onChange={(e) => setFilter((f) => ({ ...f, keyword: e.target.value }))}
              placeholder="例: ログイン"
            />
          </div>
        </div>
      </div>

      {/* 一括選択ツールバー (PR #161): フィルター適用時のみ表示 */}
      {filterApplied && (
        <div className="flex items-center justify-between gap-2 py-2">
          <div className="text-sm text-muted-foreground">
            一括編集対象 (作成者が自分のもの): {selectableIds.length} 件 / 選択中: {selectedIds.size} 件
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
            <Button
              size="sm"
              onClick={openBulk}
              disabled={selectedIds.size === 0}
            >
              一括編集 ({selectedIds.size})
            </Button>
          </div>
        </div>
      )}

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
                  aria-label="表示中の編集可能行を全選択"
                  checked={allSelectableSelected}
                  disabled={selectableIds.length === 0}
                  onChange={toggleAll}
                  className="rounded"
                />
              </ResizableHead>
            )}
            <ResizableHead columnKey="project" defaultWidth={140}>プロジェクト</ResizableHead>
            {!typeFilter && <ResizableHead columnKey="type" defaultWidth={80}>種別</ResizableHead>}
            <ResizableHead columnKey="title" defaultWidth={220}>件名</ResizableHead>
            <ResizableHead columnKey="state" defaultWidth={100}>状態</ResizableHead>
            <ResizableHead columnKey="assignee" defaultWidth={120}>担当者</ResizableHead>
            <ResizableHead columnKey="deadline" defaultWidth={110}>期限</ResizableHead>
            <ResizableHead columnKey="impact" defaultWidth={80}>影響度</ResizableHead>
            <ResizableHead columnKey="likelihood" defaultWidth={100}>発生可能性</ResizableHead>
            <ResizableHead columnKey="priority" defaultWidth={80}>優先度</ResizableHead>
            <ResizableHead columnKey="createdAt" defaultWidth={130}>作成日時</ResizableHead>
            <ResizableHead columnKey="createdBy" defaultWidth={120}>作成者</ResizableHead>
            <ResizableHead columnKey="updatedAt" defaultWidth={130}>更新日時</ResizableHead>
            <ResizableHead columnKey="updatedBy" defaultWidth={120}>更新者</ResizableHead>
            <ResizableHead columnKey="attachments" defaultWidth={200}>添付</ResizableHead>
            {isAdmin && <ResizableHead columnKey="actions" defaultWidth={80}>操作</ResizableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {filteredRisks.map((r) => (
            <TableRow
              key={r.id}
              className="cursor-pointer hover:bg-muted"
              onClick={() => handleRowClick(r)}
            >
              {filterApplied && (
                <TableCell onClick={(e) => e.stopPropagation()}>
                  {r.viewerIsCreator ? (
                    <input
                      type="checkbox"
                      aria-label={`${r.title} を一括編集対象に追加`}
                      checked={selectedIds.has(r.id)}
                      onChange={() => toggleOne(r.id)}
                      className="rounded"
                    />
                  ) : (
                    <span className="text-xs text-muted-foreground" title="自分が作成したものではないため一括編集できません">-</span>
                  )}
                </TableCell>
              )}
              <TableCell className="text-sm" onClick={(e) => e.stopPropagation()}>
                {r.projectName == null ? (
                  <span className="text-muted-foreground">（非公開）</span>
                ) : r.canAccessProject ? (
                  <Link href={`/projects/${r.projectId}`} className="text-info hover:underline">
                    {r.projectName}
                  </Link>
                ) : (
                  <span className="text-muted-foreground">
                    {r.projectName}
                    {r.projectDeleted && <span className="ml-1 text-xs text-destructive">(削除済)</span>}
                  </span>
                )}
              </TableCell>
              {!typeFilter && (
                <TableCell>
                  <Badge variant={typeColors[r.type] || 'outline'}>
                    {r.type === 'risk' ? 'リスク' : '課題'}
                  </Badge>
                </TableCell>
              )}
              <TableCell className="font-medium">{r.title}</TableCell>
              <TableCell className="text-sm">{STATE_LABELS[r.state] ?? r.state}</TableCell>
              <TableCell className="text-sm text-muted-foreground">
                {r.assigneeName ?? <span className="text-muted-foreground">-</span>}
              </TableCell>
              <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                {r.deadline ?? <span className="text-muted-foreground">-</span>}
              </TableCell>
              <TableCell>{PRIORITIES[r.impact as keyof typeof PRIORITIES] || r.impact}</TableCell>
              <TableCell>
                {r.likelihood
                  ? PRIORITIES[r.likelihood as keyof typeof PRIORITIES] || r.likelihood
                  : '-'}
              </TableCell>
              <TableCell>{PRIORITIES[r.priority as keyof typeof PRIORITIES] || r.priority}</TableCell>
              <TableCell className="whitespace-nowrap text-sm text-muted-foreground">{formatDateTime(r.createdAt)}</TableCell>
              <TableCell className="text-sm text-muted-foreground">
                {r.createdByName ?? <span className="text-muted-foreground">-</span>}
              </TableCell>
              <TableCell className="whitespace-nowrap text-sm text-muted-foreground">{formatDateTime(r.updatedAt)}</TableCell>
              <TableCell className="text-sm text-muted-foreground">
                {r.updatedByName ?? <span className="text-muted-foreground">-</span>}
              </TableCell>
              <TableCell onClick={(e) => e.stopPropagation()}>
                <AttachmentsCell items={attachmentsByEntity[r.id] ?? []} />
              </TableCell>
              {isAdmin && (
                <TableCell onClick={(e) => e.stopPropagation()}>
                  <AdminRiskDeleteButton
                    projectId={r.projectId}
                    riskId={r.id}
                    label={r.title}
                  />
                </TableCell>
              )}
            </TableRow>
          ))}
          {filteredRisks.length === 0 && (
            <TableRow>
              <TableCell
                colSpan={(isAdmin ? 15 : 14) - (typeFilter ? 1 : 0) + (filterApplied ? 1 : 0)}
                className="py-8 text-center text-muted-foreground"
              >
                {typeFilter === 'issue' ? '課題がありません' : typeFilter === 'risk' ? 'リスクがありません' : 'リスク/課題がありません'}
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
        onSaved={async () => { router.refresh(); }}
        readOnly={true}
      />

      {/* 一括編集ダイアログ (PR #161) */}
      <Dialog open={bulkOpen} onOpenChange={setBulkOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>一括編集 ({selectedIds.size} 件)</DialogTitle>
            <DialogDescription>
              チェックを入れた項目だけが対象に適用されます。
              他人が作成した行はサーバ側で自動的に除外されます。
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            {/* 状態 */}
            <div className="flex items-start gap-2">
              <input
                type="checkbox"
                checked={bulkApply.state}
                onChange={(e) => setBulkApply((a) => ({ ...a, state: e.target.checked }))}
                className="mt-2 rounded"
                aria-label="状態を一括更新する"
              />
              <div className="flex-1 space-y-1">
                <Label className="text-sm">状態</Label>
                <div className={bulkApply.state ? '' : 'pointer-events-none opacity-50'}>
                  <Select
                    value={bulkValues.state}
                    onValueChange={(v) => {
                      if (v) setBulkValues((b) => ({ ...b, state: v }));
                    }}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {Object.entries(STATE_LABELS).map(([k, v]) => (
                        <SelectItem key={k} value={k}>{v}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>

            {/* 担当者 */}
            <div className="flex items-start gap-2">
              <input
                type="checkbox"
                checked={bulkApply.assigneeId}
                onChange={(e) => setBulkApply((a) => ({ ...a, assigneeId: e.target.checked }))}
                className="mt-2 rounded"
                aria-label="担当者を一括更新する"
              />
              <div className="flex-1 space-y-1">
                <Label className="text-sm">担当者 (UUID 直接入力)</Label>
                <div className={bulkApply.assigneeId ? 'space-y-1' : 'pointer-events-none space-y-1 opacity-50'}>
                  <Input
                    placeholder="ユーザー ID (UUID)"
                    value={bulkValues.assigneeId}
                    disabled={bulkAssigneeClear}
                    onChange={(e) => setBulkValues((b) => ({ ...b, assigneeId: e.target.value }))}
                  />
                  <label className="flex items-center gap-1 text-xs text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={bulkAssigneeClear}
                      onChange={(e) => setBulkAssigneeClear(e.target.checked)}
                      className="rounded"
                    />
                    担当者をクリア (未割り当てに戻す)
                  </label>
                  <p className="text-xs text-muted-foreground">
                    ※ 横断ビューでは選択肢候補を持てないため UUID 入力。
                    通常は各プロジェクトの個別画面で編集してください。
                  </p>
                </div>
              </div>
            </div>

            {/* 期限 */}
            <div className="flex items-start gap-2">
              <input
                type="checkbox"
                checked={bulkApply.deadline}
                onChange={(e) => setBulkApply((a) => ({ ...a, deadline: e.target.checked }))}
                className="mt-2 rounded"
                aria-label="期限を一括更新する"
              />
              <div className="flex-1 space-y-1">
                <Label className="text-sm">期限</Label>
                <div className={bulkApply.deadline ? 'space-y-1' : 'pointer-events-none space-y-1 opacity-50'}>
                  <Input
                    type="date"
                    value={bulkValues.deadline}
                    disabled={bulkDeadlineClear}
                    onChange={(e) => setBulkValues((b) => ({ ...b, deadline: e.target.value }))}
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

          <DialogFooter>
            <Button variant="outline" onClick={() => setBulkOpen(false)}>キャンセル</Button>
            <Button onClick={submitBulk}>適用</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ResizableColumnsProvider>
  );
}
