'use client';

/**
 * 全リスク / 全課題画面 (横断表示) のテーブルコンポーネント。
 *
 * 役割:
 *   全プロジェクト横断で visibility='public' のリスク/課題を一覧表示する。
 *   PR #60 #1 でリスクと課題を別タブに分離 (本コンポーネントは type を prop で受け取る)。
 *
 * 行クリック動作 (2026-04-24 改修 + PR #165 で再確認):
 *   - 常に **read-only ダイアログ** で詳細を開く (編集不可)
 *   - 編集はプロジェクト内「リスク/課題一覧」画面から作成者本人のみ実施 (一括編集も同画面)
 *   - 削除は admin のみ可 (テーブル右側の専用ボタン経由、全リスク/全課題からの管理削除用)
 *
 * 設計ルール (PR #165 で再確定):
 *   - **「全○○」 = 参照のみ** (本画面)
 *   - **「○○一覧」 = CRUD + 一括編集** (`/projects/[id]/risks` 等の RisksClient)
 *   PR #161 で誤って本画面に bulk UI を入れていたが、PR #165 で原状回復。
 *
 * 関連: SPECIFICATION.md (全リスク・全課題画面)
 */

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { nativeSelectClass } from '@/components/ui/native-select-style';
import {
  TableBody, TableCell, TableHeader, TableRow,
} from '@/components/ui/table';
import { RiskEditDialog } from '@/components/dialogs/risk-edit-dialog';
import { PRIORITIES, RISK_ISSUE_STATES, VISIBILITIES } from '@/types';
import type { AllRiskDTO } from '@/services/risk.service';
import type { MemberDTO } from '@/services/member.service';
import { AdminRiskDeleteButton } from './admin-delete-button';
import { useFormatters } from '@/lib/use-formatters';
import { matchesAnyKeyword } from '@/lib/text-search';
// Phase E 要件 1〜3 (2026-04-29): 共通行クリック + フィルタバー部品
import { ClickableRow } from '@/components/common/clickable-row';
import { FilterBar } from '@/components/common/filter-bar';
import { useBatchAttachments } from '@/components/attachments/use-batch-attachments';
import { AttachmentsCell } from '@/components/attachments/attachments-cell';
import { ResizableHead } from '@/components/ui/resizable-columns';
import { ResizableTableShell } from '@/components/common/resizable-table-shell';
import { SortableResizableHead } from '@/components/sort/sortable-resizable-head';
import { useMultiSort } from '@/components/sort/use-multi-sort';
import { multiSort } from '@/lib/multi-sort';

const typeColors: Record<string, 'default' | 'destructive' | 'outline'> = {
  risk: 'outline',
  issue: 'destructive',
};

// PR feat/sortable-columns: カラム列キー → 行値の getter。multiSort の比較に使う。
function getRiskSortValue(r: AllRiskDTO, columnKey: string): unknown {
  switch (columnKey) {
    case 'project': return r.projectName ?? '';
    case 'type': return r.type;
    case 'title': return r.title;
    case 'priority': return r.priority;
    case 'state': return r.state;
    case 'visibility': return r.visibility;
    case 'assignee': return r.assigneeName ?? '';
    case 'createdAt': return r.createdAt;
    case 'createdBy': return r.createdByName ?? '';
    case 'updatedAt': return r.updatedAt;
    case 'updatedBy': return r.updatedByName ?? '';
    default: return null;
  }
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
  const tRisk = useTranslations('risk');
  const { formatDateTime } = useFormatters();
  const [editingRisk, setEditingRisk] = useState<AllRiskDTO | null>(null);
  const [members, setMembers] = useState<MemberDTO[]>([]);

  // PR-δ / 項目 12: 全リスク/全課題に検索 (keyword) + state/priority フィルタを追加。
  // ○○一覧と同等の絞り込み機能を「全○○」にも横展開し、「同じ意味の画面は同じ機能」を実現。
  const [filter, setFilter] = useState({ keyword: '', state: '', priority: '' });

  // PR feat/sortable-columns (2026-05-01): カラムソート (sessionStorage 永続化、複数列対応)。
  // typeFilter ごとに保存先を分けて、リスク/課題タブでソート設定を独立させる。
  const { sortState, setSortColumn } = useMultiSort(
    `sort:all-risks${typeFilter ? `:${typeFilter}` : ''}`,
  );

  const filteredRisks = useMemo(() => {
    let xs = typeFilter ? risks.filter((r) => r.type === typeFilter) : risks;
    if (filter.state) xs = xs.filter((r) => r.state === filter.state);
    if (filter.priority) xs = xs.filter((r) => r.priority === filter.priority);
    if (filter.keyword.trim()) {
      // Phase C 要件 19 (2026-04-28): 空白区切りで OR 検索
      xs = xs.filter((r) =>
        matchesAnyKeyword(filter.keyword, [
          r.title,
          r.content,
          r.assigneeName,
          r.reporterName,
        ]),
      );
    }
    return multiSort(xs, sortState, getRiskSortValue);
  }, [risks, typeFilter, filter, sortState]);

  const attachmentsByEntity = useBatchAttachments(
    'risk',
    filteredRisks.map((r) => r.id),
  );

  // 2026-04-24: 全リスク/全課題は全員 read-only。行クリックで参照ダイアログを開く。
  // canAccessProject=true のメンバーならメンバー一覧を取得して担当者表示を補完、非メンバーはスキップ。
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

  return (
    <>
      {/* PR-δ / 項目 12: 検索 + フィルタ (○○一覧と同 UX に揃える) */}
      <FilterBar className="mb-3">
        <div className="grid grid-cols-1 gap-2 md:grid-cols-4">
          <div className="md:col-span-2">
            <Label htmlFor={`all-risks-filter-keyword-${typeFilter ?? 'all'}`} className="text-xs">{tRisk('keyword')}</Label>
            <Input
              id={`all-risks-filter-keyword-${typeFilter ?? 'all'}`}
              value={filter.keyword}
              onChange={(e) => setFilter((f) => ({ ...f, keyword: e.target.value }))}
              placeholder={tRisk('keywordPlaceholder')}
            />
          </div>
          <div>
            <Label htmlFor={`all-risks-filter-state-${typeFilter ?? 'all'}`} className="text-xs">{tRisk('state')}</Label>
            <select
              id={`all-risks-filter-state-${typeFilter ?? 'all'}`}
              value={filter.state}
              onChange={(e) => setFilter((f) => ({ ...f, state: e.target.value }))}
              className={nativeSelectClass}
            >
              <option value="">{tRisk('all')}</option>
              {Object.entries(RISK_ISSUE_STATES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </div>
          <div>
            <Label htmlFor={`all-risks-filter-priority-${typeFilter ?? 'all'}`} className="text-xs">{tRisk('priority')}</Label>
            <select
              id={`all-risks-filter-priority-${typeFilter ?? 'all'}`}
              value={filter.priority}
              onChange={(e) => setFilter((f) => ({ ...f, priority: e.target.value }))}
              className={nativeSelectClass}
            >
              <option value="">{tRisk('all')}</option>
              {Object.entries(PRIORITIES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </div>
        </div>
      </FilterBar>
      <ResizableTableShell tableKey="all-risks">
        <TableHeader>
          <TableRow>
            <SortableResizableHead columnKey="project" defaultWidth={140} label={tRisk('project')} sortState={sortState} onSortChange={setSortColumn} />
            {!typeFilter && <SortableResizableHead columnKey="type" defaultWidth={80} label={tRisk('kind')} sortState={sortState} onSortChange={setSortColumn} />}
            <SortableResizableHead columnKey="title" defaultWidth={220} label={tRisk('subject')} sortState={sortState} onSortChange={setSortColumn} />
            {/* PR-δ / 項目 11: ○○一覧と同じ priority カラムを表示 (impact/likelihood は非表示、PR-γ 整合) */}
            <SortableResizableHead columnKey="priority" defaultWidth={80} label={tRisk('priority')} sortState={sortState} onSortChange={setSortColumn} />
            <SortableResizableHead columnKey="state" defaultWidth={100} label={tRisk('state')} sortState={sortState} onSortChange={setSortColumn} />
            <SortableResizableHead columnKey="visibility" defaultWidth={90} label={tRisk('visibility')} sortState={sortState} onSortChange={setSortColumn} />
            <SortableResizableHead columnKey="assignee" defaultWidth={120} label={tRisk('assignee')} sortState={sortState} onSortChange={setSortColumn} />
            <SortableResizableHead columnKey="createdAt" defaultWidth={130} label={tRisk('createdAt')} sortState={sortState} onSortChange={setSortColumn} />
            <SortableResizableHead columnKey="createdBy" defaultWidth={120} label={tRisk('createdBy')} sortState={sortState} onSortChange={setSortColumn} />
            <SortableResizableHead columnKey="updatedAt" defaultWidth={130} label={tRisk('updatedAt')} sortState={sortState} onSortChange={setSortColumn} />
            <SortableResizableHead columnKey="updatedBy" defaultWidth={120} label={tRisk('updatedBy')} sortState={sortState} onSortChange={setSortColumn} />
            <ResizableHead columnKey="attachments" defaultWidth={200}>{tRisk('attachment')}</ResizableHead>
            {isAdmin && <ResizableHead columnKey="actions" defaultWidth={80}>{tRisk('actions')}</ResizableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {filteredRisks.map((r) => (
            <ClickableRow
              key={r.id}
              onClick={() => handleRowClick(r)}
            >
              <TableCell className="text-sm" onClick={(e) => e.stopPropagation()}>
                {r.projectName == null ? (
                  <span className="text-muted-foreground">{tRisk('private')}</span>
                ) : r.canAccessProject ? (
                  <Link href={`/projects/${r.projectId}`} className="text-info hover:underline">
                    {r.projectName}
                  </Link>
                ) : (
                  <span className="text-muted-foreground">
                    {r.projectName}
                    {r.projectDeleted && <span className="ml-1 text-xs text-destructive">{tRisk('deleted')}</span>}
                  </span>
                )}
              </TableCell>
              {!typeFilter && (
                <TableCell>
                  <Badge variant={typeColors[r.type] || 'outline'}>
                    {r.type === 'risk' ? tRisk('labelRisk') : tRisk('labelIssue')}
                  </Badge>
                </TableCell>
              )}
              <TableCell className="font-medium">{r.title}</TableCell>
              {/* PR-δ / 項目 11: priority / state / visibility / assignee の順 (○○一覧と同列配置) */}
              <TableCell>{PRIORITIES[r.priority as keyof typeof PRIORITIES] || r.priority}</TableCell>
              <TableCell>
                <Badge variant="outline">
                  {RISK_ISSUE_STATES[r.state as keyof typeof RISK_ISSUE_STATES] || r.state}
                </Badge>
              </TableCell>
              <TableCell className="text-sm">
                {VISIBILITIES[r.visibility as keyof typeof VISIBILITIES] || r.visibility}
              </TableCell>
              <TableCell className="text-sm text-muted-foreground">
                {r.assigneeName ?? <span className="text-muted-foreground">-</span>}
              </TableCell>
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
            </ClickableRow>
          ))}
          {filteredRisks.length === 0 && (
            <TableRow>
              {/* PR-δ: カラム数変更 (impact/likelihood 削除 → state/visibility 追加で +1, -2 = 最終的に -1)。
                  base = isAdmin ? 12 : 11、typeFilter 時はさらに -1。*/}
              <TableCell colSpan={(isAdmin ? 12 : 11) - (typeFilter ? 1 : 0)} className="py-8 text-center text-muted-foreground">
                {typeFilter === 'issue' ? tRisk('noneIssue') : typeFilter === 'risk' ? tRisk('noneRisk') : tRisk('noneBothSlash')}
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </ResizableTableShell>

      <RiskEditDialog
        risk={editingRisk}
        members={members}
        open={editingRisk != null}
        onOpenChange={(v) => { if (!v) setEditingRisk(null); }}
        onSaved={async () => { router.refresh(); }}
        // 2026-04-24 + PR #165: 全リスク/全課題は編集不可 (読み取り専用)。編集は ○○一覧 経由。
        readOnly={true}
      />
    </>
  );
}
