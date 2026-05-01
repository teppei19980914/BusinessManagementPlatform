'use client';

/**
 * ステークホルダー画面 (PMBOK 13) のクライアントコンポーネント。
 *
 * 役割:
 *   - 一覧表示 (影響度 desc → 関心度 desc)
 *   - Power/Interest grid 4 象限の可視化 (上段) + 一覧テーブル (下段)
 *   - 新規登録ボタン + 行クリックで編集ダイアログ
 *   - Engagement Gap が 0 でないステークホルダーをハイライト (働きかけ必要)
 *
 * 認可:
 *   このコンポーネントは PM/TL + admin のみが到達できる前提
 *   (project-detail-client 側でタブ自体を非表示にしている)。
 *
 * 関連: SPECIFICATION.md / DESIGN.md (ステークホルダー管理)
 */

import { useCallback, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useLoading } from '@/components/loading-overlay';
import { useToast } from '@/components/toast-provider';
import {
  TableBody, TableCell, TableHeader, TableRow,
} from '@/components/ui/table';
import { ResizableHead } from '@/components/ui/resizable-columns';
import { SortableResizableHead } from '@/components/sort/sortable-resizable-head';
import { useMultiSort } from '@/components/sort/use-multi-sort';
import { multiSort } from '@/lib/multi-sort';
import { ResizableTableShell } from '@/components/common/resizable-table-shell';
import { StakeholderEditDialog } from '@/components/dialogs/stakeholder-edit-dialog';
import {
  STAKEHOLDER_ATTITUDES,
  STAKEHOLDER_ENGAGEMENTS,
  STAKEHOLDER_PRIORITIES,
  STAKEHOLDER_PRIORITY_ORDER,
  STAKEHOLDER_QUADRANTS,
  type StakeholderPriority,
  type StakeholderQuadrant,
} from '@/config/master-data';
import { nativeSelectClass } from '@/components/ui/native-select-style';
import { Label } from '@/components/ui/label';
// Phase E 要件 1〜3 (2026-04-29): 共通行クリック部品
import { ClickableRow } from '@/components/common/clickable-row';
import type { StakeholderDTO } from '@/services/stakeholder.service';
import type { MemberDTO } from '@/services/member.service';

const ATTITUDE_BADGE_VARIANT: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  supportive: 'default',
  neutral: 'outline',
  opposing: 'destructive',
};

const QUADRANT_ORDER: StakeholderQuadrant[] = [
  'manage_closely',
  'keep_satisfied',
  'keep_informed',
  'monitor',
];

const QUADRANT_DESCRIPTION_KEYS: Record<StakeholderQuadrant, string> = {
  manage_closely: 'quadrantManageCloselyDescription',
  keep_satisfied: 'quadrantKeepSatisfiedDescription',
  keep_informed: 'quadrantKeepInformedDescription',
  monitor: 'quadrantMonitorDescription',
};

const QUADRANT_BG: Record<StakeholderQuadrant, string> = {
  manage_closely: 'bg-destructive/10 border-destructive/40',
  keep_satisfied: 'bg-warning/10 border-warning/40',
  keep_informed: 'bg-info/10 border-info/40',
  monitor: 'bg-muted/50 border-muted-foreground/20',
};

// Phase D 要件 11/12 (2026-04-28): 優先度バッジの色分け。
//   high   = destructive (赤): 最重要、密接連携
//   medium = warning (橙): 状況に応じた働きかけ
//   low    = secondary (灰): モニタリングのみ
const PRIORITY_BADGE_VARIANT: Record<StakeholderPriority, 'destructive' | 'default' | 'secondary'> = {
  high: 'destructive',
  medium: 'default',
  low: 'secondary',
};

// PR feat/sortable-columns: カラム列キー → 行値の getter。multiSort の比較に使う。
function getStakeholderSortValue(s: StakeholderDTO, columnKey: string): unknown {
  switch (columnKey) {
    case 'priority': return s.priority;
    case 'name': return s.name;
    case 'organization': return s.organization ?? '';
    case 'role': return s.role ?? '';
    case 'influence': return s.influence;
    case 'interest': return s.interest;
    case 'attitude': return s.attitude;
    case 'engagement': return s.currentEngagement;
    case 'gap': return s.engagementGap;
    default: return null;
  }
}

type Props = {
  projectId: string;
  stakeholders: StakeholderDTO[];
  members: MemberDTO[];
  onReload: () => Promise<void> | void;
};

export function StakeholdersClient({ projectId, stakeholders, members, onReload }: Props) {
  const t = useTranslations('stakeholder');
  const tAction = useTranslations('action');
  const { withLoading } = useLoading();
  const { showSuccess, showError } = useToast();
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [editing, setEditing] = useState<StakeholderDTO | null>(null);
  // Phase D 要件 12 (2026-04-28): 優先度フィルタ ('' = 全件、'high'|'medium'|'low' = 該当のみ)
  const [priorityFilter, setPriorityFilter] = useState<'' | StakeholderPriority>('');
  // PR feat/sortable-columns (2026-05-01): カラムソート (sessionStorage 永続化、複数列対応)。
  const { sortState, setSortColumn } = useMultiSort('sort:project-stakeholders');

  const reload = useCallback(async () => {
    await onReload();
  }, [onReload]);

  // 4 象限ごとにグルーピング (matrix 描画用)。Power/Interest grid は priority と独立に
  // 全体を見渡せる必要があるため、フィルタの影響を受けない。
  const byQuadrant: Record<StakeholderQuadrant, StakeholderDTO[]> = {
    manage_closely: [],
    keep_satisfied: [],
    keep_informed: [],
    monitor: [],
  };
  for (const s of stakeholders) byQuadrant[s.quadrant].push(s);

  // 一覧テーブル側のみ priority filter を適用 (サービス層で priority asc ソート済)
  const filteredStakeholders = multiSort(
    priorityFilter
      ? stakeholders.filter((s) => s.priority === priorityFilter)
      : stakeholders,
    sortState,
    getStakeholderSortValue,
  );

  const gapCount = stakeholders.filter((s) => s.engagementGap !== 0).length;

  async function handleDelete(s: StakeholderDTO) {
    if (!confirm(t('deleteConfirm', { name: s.name }))) return;
    const res = await withLoading(() =>
      fetch(`/api/projects/${projectId}/stakeholders/${s.id}`, { method: 'DELETE' }),
    );
    if (!res.ok) {
      showError('ステークホルダーの削除に失敗しました');
      return;
    }
    showSuccess('ステークホルダーを削除しました');
    await reload();
  }

  return (
    <div className="space-y-6">
      {/* Phase A 要件 6: h2 ページタイトル削除 (タブ名と重複のため)。件数 + 警告サマリは維持。 */}
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          {t('countSummary', { count: stakeholders.length })}
          {gapCount > 0 && (
            <span className="ml-2 text-warning">
              {t('engagementGapWarning', { count: gapCount })}
            </span>
          )}
        </p>
        <Button
          onClick={() => setIsCreateOpen(true)}
          className="shrink-0"
        >
          {t('register')}
        </Button>
      </div>

      {/* Power/Interest grid 4 象限 ヒートマップ */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {QUADRANT_ORDER.map((q) => (
          <div
            key={q}
            className={`rounded-lg border p-3 ${QUADRANT_BG[q]}`}
          >
            <div className="mb-2 flex items-baseline justify-between gap-2">
              <h3 className="text-sm font-semibold">{STAKEHOLDER_QUADRANTS[q]}</h3>
              <span className="text-xs text-muted-foreground">
                {t('memberCountUnit', { count: byQuadrant[q].length })}
              </span>
            </div>
            <p className="mb-2 text-xs text-muted-foreground">{t(QUADRANT_DESCRIPTION_KEYS[q])}</p>
            <ul className="space-y-1">
              {byQuadrant[q].map((s) => (
                <li key={s.id} className="flex items-center gap-2 text-sm">
                  <button
                    type="button"
                    onClick={() => setEditing(s)}
                    className="flex-1 truncate text-left hover:underline"
                  >
                    {s.name}
                    {s.organization && (
                      <span className="ml-1 text-xs text-muted-foreground">
                        ({s.organization})
                      </span>
                    )}
                  </button>
                  <Badge
                    variant={ATTITUDE_BADGE_VARIANT[s.attitude] ?? 'outline'}
                    className="shrink-0 text-xs"
                  >
                    {STAKEHOLDER_ATTITUDES[s.attitude]}
                  </Badge>
                </li>
              ))}
              {byQuadrant[q].length === 0 && (
                <li className="text-xs text-muted-foreground">{t('noMembers')}</li>
              )}
            </ul>
          </div>
        ))}
      </div>

      {/* Phase D 要件 12 (2026-04-28): 優先度フィルタ */}
      <div className="flex items-end gap-2">
        <div>
          <Label htmlFor="stakeholder-priority-filter" className="text-xs">
            {t('columnPriority')}
          </Label>
          <select
            id="stakeholder-priority-filter"
            value={priorityFilter}
            onChange={(e) => setPriorityFilter(e.target.value as '' | StakeholderPriority)}
            className={nativeSelectClass}
          >
            <option value="">{t('priorityFilterAll')}</option>
            {STAKEHOLDER_PRIORITY_ORDER.map((p) => (
              <option key={p} value={p}>{STAKEHOLDER_PRIORITIES[p]}</option>
            ))}
          </select>
        </div>
      </div>

      {/* 一覧テーブル */}
      <ResizableTableShell tableKey="project-stakeholders">
          <TableHeader>
            <TableRow>
              {/* Phase D 要件 11/12: 優先度列を最左に配置 (一覧上部 = 高優先度) */}
              <SortableResizableHead columnKey="priority" defaultWidth={70} label={t('columnPriority')} sortState={sortState} onSortChange={setSortColumn} />
              <SortableResizableHead columnKey="name" defaultWidth={160} label={t('columnName')} sortState={sortState} onSortChange={setSortColumn} />
              <SortableResizableHead columnKey="organization" defaultWidth={140} label={t('columnOrganization')} sortState={sortState} onSortChange={setSortColumn} />
              <SortableResizableHead columnKey="role" defaultWidth={100} label={t('columnRole')} sortState={sortState} onSortChange={setSortColumn} />
              <SortableResizableHead columnKey="influence" defaultWidth={70} label={t('columnInfluence')} sortState={sortState} onSortChange={setSortColumn} />
              <SortableResizableHead columnKey="interest" defaultWidth={70} label={t('columnInterest')} sortState={sortState} onSortChange={setSortColumn} />
              <SortableResizableHead columnKey="attitude" defaultWidth={70} label={t('columnAttitude')} sortState={sortState} onSortChange={setSortColumn} />
              <SortableResizableHead columnKey="engagement" defaultWidth={140} label={t('columnEngagement')} sortState={sortState} onSortChange={setSortColumn} />
              <SortableResizableHead columnKey="gap" defaultWidth={60} label={t('columnGap')} sortState={sortState} onSortChange={setSortColumn} />
              <ResizableHead columnKey="actions" defaultWidth={70}>{t('columnActions')}</ResizableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredStakeholders.map((s) => (
              <ClickableRow
                key={s.id}
                onClick={() => setEditing(s)}
              >
                <TableCell>
                  <Badge variant={PRIORITY_BADGE_VARIANT[s.priority]}>
                    {STAKEHOLDER_PRIORITIES[s.priority]}
                  </Badge>
                </TableCell>
                <TableCell className="font-medium">
                  {s.name}
                  {s.userId && (
                    <span className="ml-1 text-xs text-info">{t('internalLabel')}</span>
                  )}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {s.organization || '-'}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">{s.role || '-'}</TableCell>
                <TableCell>{s.influence}</TableCell>
                <TableCell>{s.interest}</TableCell>
                <TableCell>
                  <Badge variant={ATTITUDE_BADGE_VARIANT[s.attitude] ?? 'outline'}>
                    {STAKEHOLDER_ATTITUDES[s.attitude]}
                  </Badge>
                </TableCell>
                <TableCell className="text-xs">
                  {STAKEHOLDER_ENGAGEMENTS[s.currentEngagement]}
                  <span className="mx-1 text-muted-foreground">→</span>
                  {STAKEHOLDER_ENGAGEMENTS[s.desiredEngagement]}
                </TableCell>
                <TableCell>
                  {s.engagementGap === 0 ? (
                    <Badge variant="outline">0</Badge>
                  ) : (
                    <Badge variant={s.engagementGap > 0 ? 'default' : 'secondary'}>
                      {s.engagementGap > 0 ? `+${s.engagementGap}` : s.engagementGap}
                    </Badge>
                  )}
                </TableCell>
                <TableCell onClick={(e) => e.stopPropagation()}>
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-destructive"
                    onClick={() => handleDelete(s)}
                  >
                    {tAction('delete')}
                  </Button>
                </TableCell>
              </ClickableRow>
            ))}
            {filteredStakeholders.length === 0 && (
              <TableRow>
                {/* Phase D 要件 11: priority 列追加で colSpan を 9 → 10 に */}
                <TableCell colSpan={10} className="py-8 text-center text-muted-foreground">
                  {priorityFilter ? t('noStakeholdersForFilter') : t('noStakeholders')}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
      </ResizableTableShell>

      <StakeholderEditDialog
        projectId={projectId}
        stakeholder={null}
        members={members}
        open={isCreateOpen}
        onOpenChange={setIsCreateOpen}
        onSaved={reload}
      />
      <StakeholderEditDialog
        projectId={projectId}
        stakeholder={editing}
        members={members}
        open={editing != null}
        onOpenChange={(o) => { if (!o) setEditing(null); }}
        onSaved={reload}
      />
    </div>
  );
}
